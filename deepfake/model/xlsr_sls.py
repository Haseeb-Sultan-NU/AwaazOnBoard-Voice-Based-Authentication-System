"""XLSR-SLS (Zhang, Wen, Hu, ACM MM 2024) re-implemented on HF `transformers` (no fairseq).

Spec: docs/DEEPFAKE_TRACKER.md §4. Weights: the paper's MMpaper_model.pth (fairseq key names), remapped here.

Why the encoder loop is hand-written (do NOT replace with output_hidden_states):
  * transformers v4 returns [pre-layer input, layer0..layer22, LayerNorm(layer23)], v5 returns the raw layer outputs.
    A Colab upgrade would silently shift/normalise the features. fairseq `layer_results` = raw output of each of the
    24 blocks, which is exactly what we collect.
  * Calling the blocks ourselves means LayerDrop and SpecAugment (both on in the XLS-R config, both would break SLS,
    which needs all 24 layers and fairseq ran mask=False) can never fire, in any mode.
  * Per-layer gradient checkpointing (non-reentrant) works with it.
The final encoder LayerNorm is intentionally unused (fairseq layer_results do not include it).
"""
from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F

WINDOW = 64600          # fixed: fc1 expects 67*341 = 22,847 features
N_LAYERS = 24
HIDDEN = 1024


def xlsr_300m_config():
    from transformers import Wav2Vec2Config
    # Values = facebook/wav2vec2-xls-r-300m config (pinned here so no download / version drift).
    return Wav2Vec2Config(
        conv_dim=[512] * 7, conv_kernel=[10, 3, 3, 3, 3, 2, 2], conv_stride=[5, 2, 2, 2, 2, 2, 2], conv_bias=True,
        feat_extract_norm="layer", feat_extract_activation="gelu", do_stable_layer_norm=True,
        hidden_size=HIDDEN, num_hidden_layers=N_LAYERS, num_attention_heads=16, intermediate_size=4096,
        hidden_act="gelu", layer_norm_eps=1e-5, num_conv_pos_embeddings=128, num_conv_pos_embedding_groups=16,
        # dropouts only matter in train mode (fairseq XLS-R values); layerdrop/specaugment are bypassed anyway
        hidden_dropout=0.1, attention_dropout=0.1, activation_dropout=0.0, feat_proj_dropout=0.1,
        layerdrop=0.0, apply_spec_augment=False, mask_time_prob=0.0,
    )


class XLSRSLS(nn.Module):
    def __init__(self):
        super().__init__()
        from transformers import Wav2Vec2Model
        self.wav2vec2 = Wav2Vec2Model(xlsr_300m_config())
        self.fc0 = nn.Linear(HIDDEN, 1)
        self.first_bn = nn.BatchNorm2d(num_features=1)
        self.fc1 = nn.Linear(22847, 1024)
        self.fc3 = nn.Linear(1024, 2)
        self.grad_ckpt = False

    # ------------------------------------------------------------------ front-end
    def layer_results(self, wav: torch.Tensor) -> list[torch.Tensor]:
        """wav (B, T) float32 16 kHz, NOT normalised (fairseq SLS feeds raw samples). Returns 24 x (B, frames, 1024)."""
        w = self.wav2vec2
        feats = w.feature_extractor(wav).transpose(1, 2)            # (B, frames, 512)
        h = w.feature_projection(feats)
        h = h[0] if isinstance(h, tuple) else h                     # (B, frames, 1024)
        enc = w.encoder
        h = enc.dropout(h + enc.pos_conv_embed(h))
        outs = []
        for layer in enc.layers:
            if self.grad_ckpt and self.training:
                h = torch.utils.checkpoint.checkpoint(_run_layer, layer, h, use_reentrant=False)
            else:
                h = _run_layer(layer, h)
            outs.append(h)
        return outs

    # ------------------------------------------------------------------ SLS head
    def forward(self, wav: torch.Tensor) -> torch.Tensor:
        """wav (B, 64600) -> log-probabilities (B, 2); index 1 = bona fide."""
        if wav.dim() != 2 or wav.shape[1] != WINDOW:
            raise ValueError(f"expected (B, {WINDOW}) waveform, got {tuple(wav.shape)}")
        layers = self.layer_results(wav)
        full = torch.stack(layers, dim=1)                           # (B, 24, frames, 1024)
        pooled = full.mean(dim=2)                                   # (B, 24, 1024)
        gate = torch.sigmoid(self.fc0(pooled)).unsqueeze(-1)        # (B, 24, 1, 1)
        x = (full * gate).sum(dim=1).unsqueeze(1)                   # (B, 1, frames, 1024)
        x = F.selu(self.first_bn(x))
        x = F.max_pool2d(x, (3, 3))
        x = torch.flatten(x, 1)                                     # (B, 22847)
        x = F.selu(self.fc1(x))
        x = F.selu(self.fc3(x))                                     # upstream quirk: SELU before log-softmax
        return F.log_softmax(x, dim=1)

    def layer_gates(self, wav):
        """Diagnostics: the 24 sigmoid layer weights (B, 24)."""
        pooled = torch.stack(self.layer_results(wav), 1).mean(2)
        return torch.sigmoid(self.fc0(pooled)).squeeze(-1)

    def freeze_cnn(self):
        for p in self.wav2vec2.feature_extractor.parameters():
            p.requires_grad = False


def _run_layer(layer, h):
    out = layer(h)
    return out[0] if isinstance(out, (tuple, list)) else out


# ---------------------------------------------------------------------------- weight loading
_SKIP_PREFIXES = ("quantizer.", "project_q.", "final_proj.", "encoder.layer_norm.", "mask_emb")  # pretraining/SpecAugment only, unused by SLS


def _map_ssl_key(k: str) -> str | None:
    """fairseq Wav2Vec2Model key (after 'ssl_model.model.') -> HF Wav2Vec2Model key. None = skip."""
    import re
    if k.startswith(_SKIP_PREFIXES):
        return None
    m = re.match(r"feature_extractor\.conv_layers\.(\d+)\.(0|2\.1)\.(weight|bias)$", k)
    if m:
        return f"feature_extractor.conv_layers.{m[1]}.{'conv' if m[2] == '0' else 'layer_norm'}.{m[3]}"
    if k.startswith("layer_norm."):
        return "feature_projection." + k
    if k.startswith("post_extract_proj."):
        return k.replace("post_extract_proj.", "feature_projection.projection.")
    m = re.match(r"encoder\.pos_conv\.0\.(bias|weight_g|weight_v)$", k)
    if m:
        return "encoder.pos_conv_embed.conv." + m[1]                 # weight_g/v resolved in load_pretrained
    m = re.match(r"encoder\.layers\.(\d+)\.(.+)$", k)
    if m:
        i, rest = m[1], m[2]
        rest = (rest.replace("self_attn_layer_norm.", "layer_norm.")
                    .replace("self_attn.", "attention.")
                    .replace("fc1.", "feed_forward.intermediate_dense.")
                    .replace("fc2.", "feed_forward.output_dense."))
        return f"encoder.layers.{i}.{rest}"
    raise KeyError(f"unmapped fairseq key: {k}")


def load_pretrained(model: XLSRSLS, ckpt_path, strict: bool = True) -> dict:
    """Load MMpaper_model.pth (fairseq names, optional 'module.' prefix) into `model`. Returns a small report."""
    sd = torch.load(ckpt_path, map_location="cpu", weights_only=True)
    if "model" in sd and isinstance(sd["model"], dict):          # our own training checkpoints
        sd = sd["model"]
    sd = {k[7:] if k.startswith("module.") else k: v for k, v in sd.items()}
    if any(k.startswith("wav2vec2.") for k in sd):              # already in our (HF) format
        missing, unexpected = model.load_state_dict(sd, strict=strict)
        return {"format": "hf", "missing": list(missing), "unexpected": list(unexpected)}

    w_sd = model.wav2vec2.state_dict()
    conv = model.wav2vec2.encoder.pos_conv_embed.conv
    if hasattr(conv, "parametrizations"):                        # new torch weight_norm
        gv = {"weight_g": "encoder.pos_conv_embed.conv.parametrizations.weight.original0",
              "weight_v": "encoder.pos_conv_embed.conv.parametrizations.weight.original1"}
    else:
        gv = {"weight_g": "encoder.pos_conv_embed.conv.weight_g", "weight_v": "encoder.pos_conv_embed.conv.weight_v"}

    new_w, head, skipped = {}, {}, []
    for k, v in sd.items():
        if k.startswith("ssl_model.model."):
            hk = _map_ssl_key(k[len("ssl_model.model."):])
            if hk is None:
                skipped.append(k)
                continue
            for suffix, target in gv.items():
                if hk.endswith("." + suffix):
                    hk = target
            new_w[hk] = v
        elif k.split(".")[0] in ("fc0", "first_bn", "fc1", "fc3"):
            head[k] = v
        else:
            raise KeyError(f"unexpected checkpoint key: {k}")

    problems = []
    for hk, v in new_w.items():
        if hk not in w_sd:
            problems.append(f"no HF param {hk}")
        elif tuple(w_sd[hk].shape) != tuple(v.shape):
            problems.append(f"shape {hk}: ckpt {tuple(v.shape)} vs model {tuple(w_sd[hk].shape)}")
    missing_w = sorted(set(w_sd) - set(new_w) - {"encoder.layer_norm.weight", "encoder.layer_norm.bias"})
    if missing_w:
        problems.append(f"HF params not filled: {missing_w[:8]}{'...' if len(missing_w) > 8 else ''}")
    if strict and problems:
        raise RuntimeError("weight mapping failed:\n  " + "\n  ".join(problems))
    model.wav2vec2.load_state_dict(new_w, strict=False)
    hm, hu = model.load_state_dict({**{f"wav2vec2.{k}": v for k, v in model.wav2vec2.state_dict().items()}, **head},
                                   strict=False)
    head_missing = [k for k in hm if not k.startswith("wav2vec2.")]
    if strict and (head_missing or hu):
        raise RuntimeError(f"head mismatch: missing {head_missing}, unexpected {hu}")
    return {"format": "fairseq", "mapped": len(new_w), "head": len(head), "skipped": len(skipped), "problems": problems}


def fixed_window(x, n: int = WINDOW):
    """First n samples; tile-repeat if shorter (= upstream pad / Arena protocol). numpy 1-D in, numpy out."""
    import numpy as np
    if len(x) >= n:
        return x[:n]
    reps = n // len(x) + 1
    return np.tile(x, reps)[:n]


def windows(x, n: int = WINDOW, max_windows: int = 4):
    """Non-overlapping n-sample windows (secondary protocol). Short clips -> one tiled window."""
    if len(x) <= n:
        return [fixed_window(x, n)]
    k = min(max_windows, len(x) // n)
    return [x[i * n:(i + 1) * n] for i in range(k)]
