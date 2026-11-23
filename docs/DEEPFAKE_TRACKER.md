# Deepfake Defense Tracker (XLSR-SLS for Urdu speaker verification)

The single place for **everything** about the anti-spoofing work: status, every model/training constraint,
data rules, the Colab/Drive operating manual, and the run log.
**Update this file at the end of every step** (status board + run log + any changed constraint).
Machine-readable values live in `deepfake/config.json`; if the two disagree, fix one in the same commit.

Started 2026-11-22 · Budget ≈ 10–14 part-time days · Training on free Colab (account rotation) · Storage on Google Drive.

---

## 1. Goal & success criteria
Add a **spoof (deepfake) detector** stage to Awaaz: `Gatekeeper → Spoof detector → Liveness → ECAPA`
(also applied to `/authenticate/continuous` for bank commands).

| # | Criterion | Measured on |
|---|---|---|
| G1 | Fine-tuned EER clearly below the zero-shot baseline | frozen EVAL-LUMS, conditions E1–E3 |
| G2 | Detector catches ElevenLabs clones that ECAPA alone accepts | frozen EVAL-EL |
| G3 | Few real users wrongly rejected (bona fide reject rate at the dev threshold, reported per condition) | EVAL-LUMS + EVAL-EL bona fide |
| G4 | Integrated into the backend + UI with acceptable CPU latency (target ≤ 3 s per check) | local / Docker |

Reference point: the LUMS paper's own detectors were at chance on this data (AASIST-L EER 0.495 VITS / 0.524 Tacotron).

---

## 2. Status board
Legend: `[ ]` todo · `[~]` in progress · `[x]` done · Markers = files in `AwaazDeepfake/state/` (the notebook prints them).

**P0 · Setup**
- [ ] P0.1 Push branch `feature/deepfake-defense` with `deepfake/` + this file
- [ ] P0.2 Home Google account: run *INIT DRIVE* cell → `MyDrive/AwaazDeepfake`
- [ ] P0.3 Share `AwaazDeepfake` (Editor) with every other Colab account + add shortcut in each (§9.1)
- [ ] P0.4 Colab Secrets in each account: `GITHUB_TOKEN` (only if repo private), optional `HF_TOKEN`

**P1 · Acquire LUMS data**
- [x] P1.1 `download_lums.py` → `raw/lums_urdu.tar` verified on Drive (marker `p1_download_lums`)
- [x] P1.2 `inventory.py` → `manifests/lums_all.csv` + summary pasted to Claude (marker `p1_inventory_lums`)

**P2 · Freeze split + build the frozen eval set**
- [x] P2.1 Choose + commit speaker split → `deepfake/splits/lums_split.json` (marker `p2_split_frozen`)
- [x] P2.2 Preprocess + build EVAL-LUMS E1/E2/E3 + DEV set, store as archives, hash them (marker `p2_eval_built`)
- [x] P2.3 Record manifest hashes in §8.5 (proof the eval set never changes)

**P3 · Baseline (zero-shot) evaluation**
- [x] P3.1 `download_pretrained.py`: MMpaper_model.pth (sha256-pinned, HF rev 6b99ebc) → Drive `models/pretrained/` (marker `p3_download_pretrained`)
- [x] P3.2 `parity_check.py`: HF port vs published ONNX on 21 real TRAIN windows + 2 synthetic, CPU and GPU (marker `p3_model_ready`). Local pre-test 2026-11-22: max |Δlogprob| 3.5e-5 → PASS
- [x] P3.3 `evaluate.py --run baseline`: score DEV e1/e2 + EVAL e1/e2/e3 → baseline table §11 (marker `p3_baseline_eval`)
- [ ] P3.4 (optional) Same for AASIST as an extra comparison row

**P4 · ElevenLabs set (human task, runs in parallel with P2/P3)**
- [ ] P4.1 Recruit 6–10 consenting speakers, record per §7.2
- [ ] P4.2 Generate clones, standardize, freeze EVAL-EL (+ optional adapt split), hash it
- [ ] P4.3 Baseline score EVAL-EL with the pretrained model

**P5 · Fine-tuning** (recipe §6; D3/D4/D10 decided 2026-11-22)
- [x] P5.0 `train.py` + `augment.py` written; locally tested (tiny model, CPU): smoke, Ctrl-C save, mid-epoch resume, finished-run guard, config-change guard, fp16 best.pt → evaluate loader
- [x] P5.1 Colab smoke test (`--smoke`): speed, GPU memory, checkpoint round trip, Drive Trash purge
- [x] P5.2 Run `ft1` = LUMS train speakers only (best = epoch 7) → P6 eval pending
- [ ] P5.3 Run `ft2` = LUMS + EL-adapt speakers (after P4) → ablation vs ft1 on EVAL-EL

**P6 · Final evaluation** on the *same* frozen sets/script → final table §11
**P7 · Integration** (`backend/src/verification/spoof_detector.py`, routes, AuthLog reason, forensics UI, Docker prefetch)
**P8 · Report + demo** (clone → passes ECAPA alone → blocked by detector)

---

## 3. Golden rules (never break these)
1. **The eval set is frozen before any model is scored on it.** Speaker-disjoint from training. Built once, stored as
   archives with SHA-256 hashes recorded in §8.5. The baseline and the fine-tuned model are scored on the
   *identical* files, with the *same* eval script (git hash recorded in the run log).
2. Eval data is **never** used for training, threshold selection, early stopping or hyperparameter choice. Those use **DEV** only.
3. Eval-time channel effects (E2/E3) are **precomputed once with fixed seeds** and stored, never re-randomized per run.
4. Same window/scoring protocol for every model (§8.2).
5. Any change to a frozen set = a *new* set with a new name (e.g. EVAL-LUMS-v2) + Decisions-log entry; old results stay valid only for the old set.

---

## 4. Model specification: XLSR-SLS (exact)
Paper: Zhang, Wen, Hu, *"Audio Deepfake Detection with Self-Supervised XLS-R and SLS Classifier"*, ACM MM 2024.
Code: github.com/QiShanZhang/SLSforADD (training) · HF `SpeechAntiSpoofingBenchmarks/XLSR-SLS` (released weights + wrapper). License MIT.

### 4.1 Front-end: XLS-R 300M (wav2vec 2.0 "large" architecture, fairseq checkpoint `xlsr2_300m.pt`)
| Part | Spec |
|---|---|
| Pretraining | self-supervised, 128 languages (~436k h). Not trained for spoofing; the SLS paper fine-tunes it end-to-end |
| Input | raw waveform, 16 kHz, mono, float32 |
| CNN feature encoder | 7 conv layers, 512 channels, kernels (10,3,3,3,3,2,2), strides (5,2,2,2,2,2,2), GELU, layer-norm → total stride 320 samples = **20 ms hop**, receptive field 400 samples = 25 ms |
| Feature projection | 512 → 1024 |
| Positional encoding | convolutional (kernel 128, 16 groups) |
| Transformer | **24 blocks**, hidden **1024**, **16 heads**, FFN **4096**, GELU, pre-LayerNorm |
| Output used | the hidden state of **every** one of the 24 blocks ("layer results"), not just the last |

### 4.2 Back-end: SLS classifier (layer-by-layer, B = batch)
Input window 64,600 samples → **T = 201 frames** (`floor((64600−400)/320)+1`).
| # | Op | Output shape | Notes |
|---|---|---|---|
| 1 | Collect 24 layer outputs | 24 × (B, 201, 1024) | |
| 2 | Avg-pool each layer over time | (B, 24, 1024) | layer descriptors |
| 3 | `fc0` Linear 1024 → 1 | (B, 24, 1) | one score per layer |
| 4 | **Sigmoid** | (B, 24, 1) | per-layer gate in (0,1); independent gates, NOT softmax (they don't sum to 1) |
| 5 | Gate × full layer features, **sum over layers** | (B, 201, 1024) | "sensitive layer selection" |
| 6 | Unsqueeze channel | (B, 1, 201, 1024) | |
| 7 | **BatchNorm2d(1)** | same | |
| 8 | **SELU** | same | |
| 9 | **MaxPool2d(3, 3)** | (B, 1, 67, 341) | |
| 10 | Flatten | (B, 22,847) | 67 × 341. **This is why the input length is fixed** |
| 11 | `fc1` Linear 22,847 → 1024 | (B, 1024) | ~23.4 M params (most of the head) |
| 12 | **SELU** | | |
| 13 | `fc3` Linear 1024 → 2 | (B, 2) | |
| 14 | **SELU** | | upstream quirk (activation before softmax); keep it for weight compatibility |
| 15 | **LogSoftmax** (dim=1) | (B, 2) | |

### 4.3 Labels, score, decision
- Class index **1 = bona fide (real)**, **0 = spoof**. Score = log-prob of class 1 → **higher = more real**.
- Decision: `spoof if score < τ`, with τ chosen **on DEV only** (§8.3).

### 4.4 Size
Total ≈ **340.8 M** params (XLS-R ≈ 317.4 M + head ≈ 23.4 M) → ≈ 1.36 GB fp32 / ≈ 0.68 GB fp16.

### 4.5 Pretrained files
| File | What | Where it goes |
|---|---|---|
| `MMpaper_model.pth` | paper's full fine-tuned state_dict (XLS-R + SLS) | Drive `models/pretrained/` |
| `xlsr2_300m.pt` | base XLS-R; only needed to *build* the fairseq architecture | **not needed** (HF port builds the architecture from a pinned config) |
| `xlsr-sls.onnx` | ONNX export of the same checkpoint (same HF repo) | parity reference only; local SSD, never Drive |

Pinned: HF `SpeechAntiSpoofingBenchmarks/XLSR-SLS` revision `6b99ebc9d9240571c4fe21b364d49845ce9b6bd9`; MMpaper_model.pth sha256 `0d315184…5fa6` (1,363,354,095 B); ONNX sha256 `0aa36298…1bbd`. Checkpoint = 440 tensors, keys `module.ssl_model.model.*` + `module.{fc0,first_bn,fc1,fc3}`; 10 pretraining-only tensors skipped (quantizer, project_q, final_proj, encoder.layer_norm, mask_emb = 1.95 M) → 338.84 M used (= 340.79 M card total).

### 4.6 Loading strategy (D2 DECIDED 2026-11-22: HF port, `deepfake/model/xlsr_sls.py`)
- Implemented as Option A, but **without hooks or `output_hidden_states`**: the 24 encoder blocks are called in our own loop and their raw outputs collected. Reason: transformers v4 and v5 define `hidden_states` differently (v5 = raw layer outputs, v4 = input + layers + final-LN), so a Colab upgrade could silently shift features. The loop also makes LayerDrop (0.1 in the XLS-R config) and SpecAugment impossible, both of which would break SLS.
- Input is the raw waveform, not mean/var-normalised (as upstream). Final encoder LayerNorm unused.
- Every eval run re-scores `parity_ref.npz` (tolerance 2e-3) before scoring, to catch library drift.

Original plan, kept for reference:
Upstream stack is old: Python 3.7, torch 1.12.1, a pinned fairseq commit. That clashes with Colab and our backend (torch 2.1).
- **Option A (preferred): port to HF `transformers`.** Use `Wav2Vec2Model` (XLS-R 300M config), remap fairseq keys → HF keys, and
  capture each block's output with **forward hooks on `encoder.layers[i]`**. Don't use `hidden_states` naively: in HF the last
  entry has the final LayerNorm applied and the first entry is the pre-block input, whereas fairseq's layer results are the raw block outputs.
  Removes fairseq from Colab and Docker.
- **Option B (fallback): fairseq** installed from the repo's bundled commit in Colab.
- **Parity check (mandatory before P3.3):** on ≥ 20 clips, A and the reference (B or the Arena wrapper's pinned scores) must agree:
  max |Δscore| < 1e-3 and identical decisions. Log the result.

---

## 5. Upstream training recipe (reference only, what the paper did)
| Setting | Value |
|---|---|
| Train data | ASVspoof 2019 LA train (English) |
| Optimizer | **Adam** over **all** params (full fine-tuning incl. XLS-R) |
| Learning rate | **1e-6** (constant) |
| Weight decay | **1e-4** |
| Batch size | default 14; README command uses **5** |
| Epochs | default 100; README command 50 |
| Loss | weighted cross-entropy (NLL on log-softmax), weights **[0.1 spoof, 0.9 bona fide]** (ASVspoof is ~9:1 spoof-heavy) |
| Augmentation | RawBoost, default `algo=3` (SSI additive noise) |
| Seed / determinism | 1234, cudnn deterministic on, benchmark off |
| Stopping | patience 1 on **training** loss (dev validation is commented out) |
| Data loader | shuffle, drop_last, 8 workers |
| Known upstream bugs | `train_epoch` uses the global optimizer; eval writer resets lists every batch. **We write our own train/eval code.** |

## 6. Our fine-tuning recipe (DECIDED 2026-11-22 as D3/D4/D10; machine values in `config.json` → `train`)
| Setting | Value | Why |
|---|---|---|
| Init | `MMpaper_model.pth` via our HF port | strongest public checkpoint |
| Trainable | 24 transformer blocks + feature projection + SLS head; **CNN feature encoder frozen** (D3) | small data; saves memory |
| Optimizer | AdamW, lr **3e-6** backbone / **3e-5** head, wd 1e-4, linear warm-up 100 steps then constant (D3) | ~3× the paper's 1e-6: 10 epochs of 3k clips vs the paper's 100 epochs of 25k; revisit if dev EER does not move by epoch 2 |
| Precision | fp16 autocast + GradScaler (train); fp32, no TF32 (all scoring) | T4 memory/speed; exact eval |
| Batch | 8 × grad-accum 2 = 16; grad-clip 1.0 | |
| Loss | weighted NLL on log-softmax, weights = N/(2·N_class) from the train manifest | train is 48.5 % bona fide |
| Train aug (D4), same probability for BOTH classes | noise 0.3 (SNR 15–40 dB, coloured), impulses 0.1, telephony 0.5 (8 kHz, HP 200–400, LP 3000–3600, SNR 10–30 dB), Opus 0.3 (12/16/24/32 kbps), random peak 0.3–0.95 | baseline shows channel = main failure; label-blind aug stops "phone-sounding = fake" |
| Crop | random 64,600 window per sample (tile if short); eval = first window | |
| Selection / early stop (D10) | **mean EER of DEV E1 and DEV E2**; patience 3; max 10 epochs | keeps clean performance while fixing telephony (pure E2 could trade away E1) |
| Determinism | sample order + augmentation seeded by (seed, epoch, index) | exact mid-epoch resume |
| Checkpoints | `<run>_last.pt` (≈3.9 GB: model + AdamW + scaler + RNG + history) every 30 min + epoch end; `<run>_best.pt` fp16 (≈0.7 GB) | Colab timeouts |
| Caveat for the report | E2/E3 are simulated channels similar to the training augmentation, so they are partly in-distribution. **EVAL-EL (real browser recordings + real ElevenLabs clones) is the honest out-of-distribution test.** | |

---

## 7. Data specification

### 7.1 LUMS Urdu deepfake dataset (train / dev / eval source)
- HF `CSALT/deepfake_detection_dataset_urdu`, **CC BY-NC 4.0** (academic use OK; never redistribute; never commit audio).
- HF snapshot (checked 2026-11-22): **1.96 GB**, `Bonafide/` 3,398 · `Spoofed_TTS/` (VITS) 1,698 · `Spoofed_Tacotron/` 1,698 = **6,794 files**,
  each split into `Speaker_01 … Speaker_17` folders. The paper describes ~37k utterances, so the HF release is a subset. Note it in the report.
- Paper facts: 17 speakers (7 F / 10 M), read speech in a quiet room on laptops/headphones. Tacotron trained per speaker;
  VITS multi-speaker, 16 kHz, 80 mel. The paper's split was 8 / 4 / 5 speakers (train / dev / eval).
- Clip lengths 0.4–40 s (HF viewer). Exact sample rate/format are confirmed by `inventory.py`.

### 7.2 ElevenLabs set (EVAL-EL; realistic modern attack) — how it is fed
| Item | Spec |
|---|---|
| Speakers | 6–10 consenting people (written consent; biometric data). Split by SPEAKER: **EL-eval ≥ 4 speakers (frozen, never trained on)**, **EL-adapt 2–3 speakers (optional, training only for run ft2)** |
| Bona fide per speaker | 20 three-digit Urdu challenges + 10 bank commands, recorded **through the app/browser mic** (WebM/Opus) |
| Cloning source | separate ~2 min free reading per speaker. **Never** used as bona fide (avoids text/session overlap) |
| Spoofs | ElevenLabs clone of each speaker saying the same 30 texts. Log model name/version + settings (D6) |
| Format-leak guard | real = browser Opus, clones = ElevenLabs MP3 → a model could learn "MP3 = fake". So clones are passed through the **same Opus round trip** as the browser path (= clone injected into the call), then both classes go through the identical §7.4 pipeline |
| Use | EL-eval: scored by `evaluate.py` for baseline, ft1, ft2 (+ system-level: % clones ECAPA accepts alone vs with detector). EL-adapt: appended to `train_sets` for ft2, oversampled ×4 so it is ~15 % of batches |
| Optional | replay attack: play clone through a phone speaker, re-record via the app |
| Storage | Drive `raw/elevenlabs/` only (never git) · delete after the FYP |

### 7.3 Splits (D1; freeze in P2.1)
- LUMS: **8 train / 4 dev / 5 eval speakers**, speaker-disjoint across ALL classes (a speaker's bona fide + VITS + Tacotron go to the same split).
  Eval should contain both genders (use the inventory's F0 hint). IDs go in `deepfake/splits/lums_split.json` (committed) and are copied here.
- Split IDs (FROZEN 2026-11-22, seed 1234, gender via F0>160 Hz → 7F/10M as in paper):
  train = S04 S05 S06 S07 S08 S11 S13 S15 (3F/5M); dev = S01 S02 S12 S14 (2F/2M); eval = S03 S09 S10 S16 S17 (2F/3M).
  File: `deepfake/splits/lums_split.json` (sha256 82910e20…). Never edit.
- Split counts (apply_split, 2026-11-22): train 1,598 bona fide + 1,596 spoof (798 VITS / 798 Tacotron); dev 800 + 800; eval 1,000 + 1,000. Bona fide 198/103/152 min train/dev/eval.
- **SHORTCUT FOUND:** Tacotron = 1,698/1,698 at 20 kHz; VITS = 16 kHz; bona fide = 3,298 at 16 kHz + 100 at 20 kHz. Sample-rate/bandwidth is a label leak in E1. Fix (D8): see §7.4 step 2b. Also 198 files share a sha256 with another file (duplicates) → P2.2 must check cross-split overlap and drop dupes inside a split.
- Inventory facts: 6,794 files, 0 unreadable, mono PCM_16; 16 kHz ×4,996 + 20 kHz ×1,798 (**shortcut risk: check label×sr in apply_split output**); median 7.8 s, 246 clips < 4.04 s.

### 7.4 Preprocessing (all sources, deterministic)
1. Decode → mono → resample to **16 kHz** float32.
2. Trim leading/trailing silence (energy VAD, conservative), loudness/peak normalize. **Same for both classes.**
2b. **(D8) Band-limit EVERY file to 7 kHz (low-pass at native rate, resample, then the same 7 kHz low-pass again at 16 kHz) so 16 kHz and 20 kHz sources look identical above 7 kHz.** Neutralises the sample-rate shortcut; E1 is therefore "clean, 7 kHz band-limited". E2/E3 (≤3.4 kHz) are unaffected.
3. Drop clips < 1.0 s (log the count). Short clips are tile-repeated to 64,600 samples at scoring time, not stored padded.
4. Store as 16-bit PCM WAV inside per-split `.tar` archives on Drive (fast to copy, then extract to local SSD).

### 7.5 Eval conditions (precomputed once, fixed seed per file = hash(relpath))
| Code | Condition | Implementation |
|---|---|---|
| **E1** | clean (after §7.4) | – |
| **E2** | telephony | same as `backend/src/audio/simulator.py` TelephonySimulator: resample 8 kHz, 300 Hz HP + 3400 Hz LP, white noise **SNR 15 dB**, peak-normalize → back to 16 kHz |
| **E3** | telephony + browser codec | E2 → WebM/Opus round trip via ffmpeg (16 kbps) → 16 kHz |

---

## 8. Evaluation protocol (frozen)
### 8.1 Sets
DEV-LUMS (threshold + early stopping) · **EVAL-LUMS** (5 speakers, E1–E3) · **EVAL-EL** (P4, E1 = as recorded, + E2).
### 8.2 Scoring
- **Score = log-odds = logp[bona] − logp[spoof]** (D9, 2026-11-22). Same ranking as upstream logp[bona], but logp[bona] saturates at ≈ −1e-5 in float32 for confident real clips (ties corrupt EER). Accept as bona fide iff score > τ.
- **Primary:** first 64,600 samples, tile-repeat if shorter (= Arena protocol, comparable with public numbers).
- **Secondary:** mean score over non-overlapping 64,600-sample windows (max 4). Report both, decide on primary.
- Scores written per file to CSV incrementally (resumable): `relpath, set, condition, label, attack, speaker, score`.
### 8.3 Metrics
- **EER %** per set × condition (primary), plus per attack (VITS / Tacotron / ElevenLabs).
- AUC. Bona fide reject rate + spoof accept rate at **τ_dev** (the EER threshold on DEV-LUMS E2).
- System level (EVAL-EL): % of clones accepted by ECAPA alone vs ECAPA + detector at τ_dev.
### 8.4 Reporting
Every result row records: model checkpoint, git hash of eval code, manifest hash, condition, date.
### 8.5 Frozen manifest hashes
| Set | Manifest | SHA-256 | Frozen on |
|---|---|---|---|
| LUMS full inventory | `manifests/lums_all.csv` | 380236322060ed101dcd3efa24ee1c54f35fe006437d009f409916dc2cf74f2a | 2026-11-22 |
| Speaker split | `deepfake/splits/lums_split.json` | 82910e202eaa792dfe6749e5f2ae6a4487b8c6d3d202f67597137c7d5106ef15 | 2026-11-22 |
| EVAL-LUMS E1 (1,995: 1000 real / 995 fake) | `manifests/proc_eval_e1.csv` | 96d2b52b8471ca3ad8b6104a75b9ae47254b7ab2d49d4ac3584f87ce5d8ee45f | 2026-11-22 |
| EVAL-LUMS E2 | `manifests/proc_eval_e2.csv` | 4c69336866c43d974ad4080b26ddb7b96e4abb43e0d3b85b420aeafbe1557f65 | 2026-11-22 |
| EVAL-LUMS E3 | `manifests/proc_eval_e3.csv` | dd42d6c86916f097063147c6757be669498916bcabb34787b918c80502370061 | 2026-11-22 |
| DEV-LUMS E1 (1,593: 800/793) | `manifests/proc_dev_e1.csv` | db175c014d6aaccf7ffc3f9641d7c5ed5eec80d4d2891d9d8a2679f19110e8a5 | 2026-11-22 |
| DEV-LUMS E2 | `manifests/proc_dev_e2.csv` | fb3cbd7e1d55cd24fc4a03c7d2aaf4ebba8edbb06b07767aec9a10b7d425bc0f | 2026-11-22 |
| TRAIN-LUMS E1 (3,088: 1499/1589) | `manifests/proc_train_e1.csv` | f7f51080a5101da55fb30fad3d99fcb0ad4798d91e062352353d2a559bb09a31 | 2026-11-22 |
| EVAL-EL | | _TBD_ | |

---

## 9. Colab & Drive operating manual

### 9.1 One-time setup
1. **Repo:** push branch `feature/deepfake-defense`. If the repo is private, make a GitHub fine-grained token
   (this repo only, *Contents: Read*) and add it as Colab Secret `GITHUB_TOKEN` in **each** account (Secrets are per account).
2. **Home account** (the one with the most free Drive): open `deepfake/colab/AwaazDeepfake.ipynb` in Colab
   (GitHub tab → repo → branch), run MASTER SEQUENCE, then the **INIT DRIVE** cell.
3. Drive web → `AwaazDeepfake` → Share → add every other account as **Editor**.
4. In **each other account**: Drive web → *Shared with me* → right-click `AwaazDeepfake` → *Organize → Add shortcut → My Drive*.
   Keep the name exactly `AwaazDeepfake`, so `/content/drive/MyDrive/AwaazDeepfake` resolves in every account.
5. Save a copy of the notebook to each account's Drive (*File → Save a copy in Drive*), or reopen it from GitHub each time.
   The notebook only holds thin cells, and all logic is in the repo.

### 9.2 Every session (incl. after timeout / account switch)
1. Runtime → T4 GPU (CPU for P1/P2 data steps, which saves GPU quota).
2. Run **MASTER SEQUENCE**. It mounts Drive, pulls the latest code, installs extras, restores local caches and prints the status board.
3. Run the next unfinished step cell. Finished steps skip themselves (markers).

### 9.3 Storage layout (`MyDrive/AwaazDeepfake/`) and budget
```
raw/          lums_urdu.tar (+ .sha256), elevenlabs/          ~2.0 GB (+ EL ~0.3 GB)
processed/    dev_e2.tar, eval_e1.tar, eval_e2.tar, eval_e3.tar, train.tar  ~3–4 GB
manifests/    *.csv, *.json (small)
models/pretrained/   MMpaper_model.pth, xlsr2_300m.pt             ~2.6 GB
checkpoints/<run>/   last.pt (weights + optimizer, ~4 GB), best.pt (fp16 weights, ~0.7 GB)
results/<run>/       scores_*.csv, metrics.json
state/        *.done markers   ·   logs/events.log (one line per event, all accounts)
```
- **Storage (updated 2026-11-23): all three accounts have 5 TB (Google AI Pro), so quota is not a constraint.** Peak use ≈ 12–13 GB. The Trash purge after checkpoint saves stays on (harmless, keeps Trash clean); `raw/lums_urdu.tar` is kept.
- ⚠ A file counts against the quota of **the account that created it**, even inside the shared folder. Deleted files sit in that
  account's **Trash and still count** until it's emptied. Empty Trash in the account that wrote old checkpoints.
- Fast path: Drive is only for big archives + checkpoints. Training/eval read from `/content/work` (local SSD), which is restored from Drive archives by MASTER SEQUENCE.

### 9.4 Timeout & checkpoint policy
- Free Colab: idle disconnects (~90 min without interaction), session hard cap (≤ 12 h), unpredictable GPU quota → plan 4–5 h per account.
- Nothing important lives only in `/content`. Every Drive write is **atomic** (`.partial` → rename), so a cut-off never leaves a "complete-looking" broken file.
- Training checkpoint = model + optimizer + GradScaler + epoch + global step + RNG states + best DEV EER + config hash + git hash.
  Saved every **15 min** and at epoch end. The train cell **auto-resumes** from `last.pt`.
- Long scoring jobs append per-file scores and skip already-scored files, so they're resumable.

### 9.5 Account-switch checklist
1. Wait for a "checkpoint saved" line (or a step's DONE line). 2. Runtime → *Disconnect and delete runtime*.
3. New account → open notebook → T4 → **MASTER SEQUENCE** → re-run the step cell (it resumes). 4. Add a run-log row.

### 9.6 Security
- No secrets in the repo or notebook outputs. Tokens only in Colab Secrets. The master cell masks the token in git output.
- Audio never goes to git (`*.wav` is already git-ignored). LUMS is non-commercial. ElevenLabs recordings are personal biometric data.
- Share `AwaazDeepfake` only with your own accounts. The ElevenLabs API key (if used) goes in Secrets, never in code.

---

## 10. Code layout (`deepfake/`)
| Path | Purpose |
|---|---|
| `config.json` | all paths, dataset ids, audio constants, seed (JSON because `*.yaml` is git-ignored repo-wide) |
| `requirements-colab.txt` | extras for Colab (never reinstall torch) |
| `common.py` | config, Drive/local paths, atomic writes, sha256, step markers, event log |
| `scripts/session_setup.py` | called by MASTER SEQUENCE: checks, folder layout, resources, cache restore, status board (`--init` creates the Drive folder) |
| `scripts/download_lums.py` | P1.1 |
| `scripts/inventory.py` | P1.2 |
| `scripts/apply_split.py` | P2.1 |
| `scripts/build_eval.py` | P2.2 (band-limit, trim, dedupe, E1/E2/E3, tars + per-file manifests; resumable) |
| `scripts/download_pretrained.py` | P3.1 |
| `scripts/parity_check.py` | P3.2 (writes `models/pretrained/parity_ref.npz`) |
| `scripts/evaluate.py` | P3.3 + P6: one evaluator for baseline and fine-tuned (`--run`, `--ckpt`) |
| `model/xlsr_sls.py` | HF port of XLSR-SLS + fairseq→HF weight mapping + windowing |
| `model/loader.py` | load model, exact-math settings (no TF32), GPU guard, parity self-check |
| `data.py` | frozen-set restore Drive→local with manifest-hash + per-file sha256 checks |
| `metrics.py` | EER / AUC / rates at τ |
| `splits/frozen_hashes.json` | frozen manifest hashes (scripts refuse to run on a changed set) |
| `scripts/train.py` | P5: resumable fine-tuning (`--smoke`, `--run`) |
| `augment.py` | label-blind channel augmentation |
| `colab/AwaazDeepfake.ipynb` | thin runner notebook (MASTER SEQUENCE + one cell per step) |
| `splits/` | frozen split JSONs (P2) |

---

## 11. Results
### Baseline (zero-shot, pretrained XLSR-SLS): EER % (primary window; multi-window in brackets)
Run `baseline`, 2026-11-22, Colab T4, eval code e9072ad, torch 2.14.1 / transformers 5.22.1. τ (dev E2) = −12.48 log-odds.
| Set | E1 clean | E2 telephony | E3 tel+Opus |
|---|---|---|---|
| DEV-LUMS (all) | 15.76 (15.51) | 26.49 (26.87) | – |
| EVAL-LUMS (all) | **10.88** (8.12) | **26.02** (26.32) | **32.98** (33.08) |
| EVAL-LUMS VITS | 15.80 (10.40) | 32.40 (30.80) | 36.00 (33.40) |
| EVAL-LUMS Tacotron | 2.41 (3.62) | 20.20 (22.26) | 30.30 (32.96) |
| EVAL-EL | | | – |

At τ_dev on EVAL (all): bona fide reject / spoof accept = E1 1.0 % / 29.8 %, E2 17.9 % / 32.9 %, E3 **56.0 %** / 13.6 %. AUC E1 0.955, E2 0.822, E3 0.746.
Reading: strong zero-shot on clean Urdu (LUMS paper's AASIST-L ≈ 50 %), but channel effects destroy it. Telephony/Opus push REAL speech toward "fake" (E3 bona fide median −13.1 vs spoof −15.4), which is the main target for fine-tuning with channel augmentation on both classes. VITS is the harder attack. Dev and eval agree (E2 26.5 vs 26.0), so the split looks sound.

### ft1 training curve (DEV only, primary window, fp16 scoring; baseline DEV = E1 15.76 / E2 26.49)
| Epoch | 1 | 2 | 3 | 4 | 5 | 6 | **7** | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| DEV E1 EER % | 20.53 | 16.26 | 14.25 | 13.12 | 14.88 | 11.49 | **9.86** | 10.99 | 10.73 | 9.86 |
| DEV E2 EER % | 24.61 | 22.35 | 22.47 | 22.10 | 23.23 | 20.03 | **17.14** | 19.15 | 20.03 | 17.89 |
Reading: steady gains to epoch 7, then a plateau with ±2–3 pt epoch-to-epoch noise (DEV has only 4 speakers). Train loss stays ~0.25–0.5 (augmentation keeps the task hard; no sign of memorising). Epoch 1 is worse than baseline on E1 (20.5 vs 15.8): the head re-calibrates first. Ran the full 10 epochs (patience hit 3/3 at epoch 10).

### Eval-looking rule (Golden rule 2, made explicit 2026-11-23)
Every run gets ONE eval pass with `evaluate.py`, and every pass is logged in §12. The final model is chosen by **DEV** (`select` metric), never by EVAL. No recipe change may be motivated by an EVAL number; changes are justified by DEV/train behaviour only.

### Final (fine-tuned): same table, filled in P6.

---

## 12. Run log
| Date | Account | Step / run | Git hash | Outcome | Notes |
|---|---|---|---|---|---|
| 2026-11-22 | – | P1.1/P1.2 run on Colab | ok | 6,794 files, manifest sha256 38023632…, tar sha256 246626ff84f9… |
| 2026-11-23 | acct 2 (switched mid-run) | P5.2 train ft1 | 6e2d591 code (0cc7985 = notebook saved from Colab, no code change) | ok | 10 epochs, 1,925 opt steps, ~7 min train + ~1 min DEV per epoch, 6–9 clips/s; resumed once at epoch 4; best epoch 7: DEV E1 9.86 % / E2 17.14 % (select 13.50 %); checkpoint saves 127–209 s; Trash purge always 0 (replaced copies apparently not trashed, or owned by the other account; irrelevant with 5 TB) |
| 2026-11-23 | – | P5.1 smoke test on Colab T4 | 647879f | PASS | 9.2 clips/s, GPU peak 9.1 GB (batch 8, no grad-ckpt needed), 3.9 GB checkpoint → Drive in 67 s, reload identical, Trash purge ok; est. ~6 min train + ~4 min DEV per epoch (~1.6 h for 10 epochs) |
| 2026-11-22 | – | P5 train.py written + local mechanics test | – | ok | tiny 2-layer model on CPU (full model needs the T4): smoke PASS, SIGINT save, resume at exact batch, finished/config guards, fp16 best.pt loads |
| 2026-11-22 | – | P3.3 baseline eval on Colab T4 | e9072ad | ok | ~9–15 files/s on T4; full table in §11; EVAL EER E1 10.9 / E2 26.0 / E3 33.0 % |
| 2026-11-22 | – | P3.1 + P3.2 on Colab T4 | 4a196bc | PASS | torch 2.14.1+cu130, transformers 5.22.1; parity on 23 windows (21 real TRAIN): CPU max|Δlogprob| 3.7e-4, GPU 1.1e-4, same decisions. Observations: Tacotron −10…−17, VITS −6…−14, bona fide −7.8…+12.5 (3/5 below 0) → default τ=0 would reject many real Urdu clips (hence τ from DEV). Silence/noise score +10.5 ("real"), so the detector must run after the Gatekeeper's no-speech check (P7) |
| 2026-11-22 | – | P3 code written + local test | – | ok | parity vs ONNX on synthetic inputs: max |Δlogprob| 3.5e-5, same decisions; full P3.1→P3.3 chain + resume tested on fake data (CPU) |
| 2026-11-22 | – | P2.2 build_eval.py run on Colab | 8120d99 | ok (~45 min) | dedupe dropped 99 (0 cross-split, 0 label conflicts); 19 short Tacotron clips dropped (<1 s after trim: eval 5, dev 7, train 7); energy >7.2 kHz ~5e-10 for all groups (Tacotron 20k 1.4e-9) → leak neutralised; p2_eval_built DONE |
| 2026-11-22 | – | P2.1 split frozen + apply_split run | ok | split sha256 82910e20…; found 20 kHz Tacotron shortcut + 198 duplicate-hash files |
| 2026-11-22 | – | P0 files created | – | ok | tracker, config, scripts, notebook (dry-run tested locally with fake data) |

---

## 13. Risks & mitigations
| Risk | Mitigation |
|---|---|
| Telephony/codec makes real speech look fake (false rejects) | augment both classes; τ from DEV E2; report bona fide reject rate |
| fairseq install / old torch | HF port (§4.6) + parity check |
| Colab timeouts / quota | Drive-first storage, atomic writes, auto-resume, account rotation |
| Drive quota (15 GB) | keep 1 last + 1 best, empty Trash, fp16 best.pt |
| Overfitting (only 8 train speakers) | frozen CNN, low LR, strong aug, early stop on DEV |
| Shortcut learning (mic/room differences between real and TTS) | same preprocessing/aug for both classes; E2/E3 eval |
| CPU latency in production (340 M params) | measure in P7; fallback AASIST or fp16/int8 dynamic quantization |
| 4 s fixed window vs long commands | multi-window scoring (§8.2) |

## 14. Open decisions
| ID | Decision | Status |
|---|---|---|
| D1 | LUMS speaker IDs per split | DECIDED 2026-11-22 (see §7.3) |
| D10 | Model selection = mean(DEV E1, DEV E2) EER | DECIDED 2026-11-22 (§6) |
| D2 | HF port vs fairseq | DECIDED 2026-11-22: HF port (§4.6) |
| D9 | Score = log-odds instead of logp[bona] (saturation) | DECIDED 2026-11-22 (§8.2) |
| D8 | 7 kHz common band-limit to remove 16k/20k label leak (§7.4 step 2b) | proposed 2026-11-22, apply in P2.2 |
| D3 | Trainable layers + LRs | DECIDED 2026-11-22 (§6) |
| D4 | Train augmentation set/probabilities | DECIDED 2026-11-22 (§6) |
| D5 | Add AASIST comparison row? | optional |
| D6 | ElevenLabs model/version for clones | P4 |
| D7 | Repo private or public (decides whether `GITHUB_TOKEN` is needed) | P0 |

## 15. Training pitfalls checklist (read before writing/running P5)
Things that would silently ruin results, and how each is handled.
| # | Pitfall | Guard |
|---|---|---|
| 1 | Eval data leaking into training, threshold or early stopping | speaker-disjoint split; τ and early stop from DEV only; eval sets touched only by `evaluate.py` |
| 2 | Frozen set rebuilt or edited | `frozen_hashes.json` check + per-file sha256 on restore (`data.py`) |
| 3 | 16 vs 20 kHz label leak (Tacotron = 20 kHz) | D8 common 7 kHz band-limit; verified energy > 7.2 kHz ≈ 5e-10 for all groups |
| 4 | Duplicate clips | dedupe in `build_eval.py` (99 dropped, 0 cross-split) |
| 5 | Shortcut "phone-sounding = fake" | channel aug (telephony/Opus/RawBoost) on BOTH classes with equal probability |
| 6 | LayerDrop / SpecAugment skipping layers (SLS needs all 24) | encoder loop is ours; both impossible (§4.6) |
| 7 | Library drift (Colab upgrades transformers) | parity self-check on every pretrained eval; training loads the same port |
| 8 | Score saturation / float ties | log-odds score (D9) |
| 9 | TF32 / non-determinism changing eval scores | `set_exact_math()` in every eval; training may use fp16 AMP, but eval is fp32 |
| 10 | BatchNorm left in train mode during dev/eval scoring | `model.eval()` for scoring, `model.train()` after; first_bn running stats saved in checkpoints |
| 11 | Class imbalance (train ≈ 48 % real) | inverse-frequency CE weights from the train manifest |
| 12 | Train crop vs eval window mismatch | train: random 64,600 crop (tile if short); eval: first window (+ multi-window secondary) |
| 13 | Gradient checkpointing with reentrant mode dropping grads | per-layer `checkpoint(use_reentrant=False)` built into the model |
| 14 | fp16 overflow / NaN loss | GradScaler; abort + reload last good checkpoint if loss is non-finite; evaluator asserts finite outputs |
| 15 | Overfitting with 8 training speakers | frozen CNN, low LR, early stop patience 3 on DEV E2 EER, max 10 epochs |
| 16 | Incomplete checkpoint on timeout (resume diverges) | atomic save of model + optimizer + scaler + epoch/step + RNG states + best EER + git/config hash |
| 17 | Drive quota (15 GB) | ONNX never on Drive; keep 1 last.pt + 1 best.pt (fp16); empty Trash; `raw/lums_urdu.tar` can be deleted after P5 if space runs out |
| 18 | DataLoader workers sharing RNG seeds (identical augmentation) | per-sample RNG seeded by (seed, epoch, index); no global RNG in workers |
| 19 | **Drive Trash**: overwriting a checkpoint on mounted Drive moves the old 3.9 GB copy to Trash (still counts) | uniquely named checkpoints + permanent delete of only those names from Trash after each save (needs the notebook's Drive-login cell); free-space check before each save, falls back to local-only with a loud warning |
| 20 | Resuming with a changed recipe | config hash stored in the checkpoint; mismatch → refuse (`--force-config` to override) |
| 21 | Format leak in EVAL-EL (browser Opus vs ElevenLabs MP3) | clones get the same Opus round trip as bona fide (§7.2) |

