"""EER / AUC / threshold metrics. Convention: score higher = more bona fide; accept as bona fide iff score > tau."""
from __future__ import annotations

import numpy as np


def eer(bona: np.ndarray, spoof: np.ndarray) -> tuple[float, float]:
    """Returns (EER in [0,1], threshold). Standard sorted-score DET computation."""
    bona, spoof = np.asarray(bona, float), np.asarray(spoof, float)
    if len(bona) == 0 or len(spoof) == 0:
        return float("nan"), float("nan")
    scores = np.concatenate([bona, spoof])
    labels = np.concatenate([np.ones(len(bona)), np.zeros(len(spoof))])
    order = np.argsort(scores, kind="mergesort")
    s, lab = scores[order], labels[order]
    frr = np.concatenate([[0.0], np.cumsum(lab) / len(bona)])             # bona with score <= threshold (rejected)
    far = np.concatenate([[1.0], 1 - np.cumsum(1 - lab) / len(spoof)])   # spoof with score > threshold (accepted)
    thr = np.concatenate([[s[0] - 1e-3], s])
    i = int(np.argmin(np.abs(frr - far)))
    return float((frr[i] + far[i]) / 2), float(thr[i])


def auc(bona, spoof) -> float:
    """P(score_bona > score_spoof), ties count 1/2 (Mann-Whitney)."""
    from scipy.stats import rankdata
    bona, spoof = np.asarray(bona, float), np.asarray(spoof, float)
    r = rankdata(np.concatenate([bona, spoof]))
    return float((r[:len(bona)].sum() - len(bona) * (len(bona) + 1) / 2) / (len(bona) * len(spoof)))


def rates_at(bona, spoof, tau: float) -> dict:
    bona, spoof = np.asarray(bona, float), np.asarray(spoof, float)
    return {"bona_reject_rate": float((bona <= tau).mean()), "spoof_accept_rate": float((spoof > tau).mean())}


def summarize(df, score_col: str, tau: float | None = None) -> dict:
    """Overall + per-attack metrics for one set/condition dataframe (columns: label, attack, score_col)."""
    b = df.loc[df.label == "bonafide", score_col].values
    out = {}
    groups = {"all": df[df.label == "spoof"]}
    groups.update({a: g for a, g in df[df.label == "spoof"].groupby("attack")})
    for name, g in groups.items():
        e, t = eer(b, g[score_col].values)
        row = {"eer": e, "eer_threshold": t, "auc": auc(b, g[score_col].values), "n_bona": int(len(b)), "n_spoof": int(len(g))}
        if tau is not None:
            row.update(rates_at(b, g[score_col].values, tau))
        out[name] = row
    return out
