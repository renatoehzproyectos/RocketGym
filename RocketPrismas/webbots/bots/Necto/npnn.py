"""Minimos bloques de red neuronal en numpy (sustituyen a PyTorch en el navegador)."""
import numpy as np


def relu(x):
    return np.maximum(x, 0.0)


def linear(x, w, b):
    return x @ w.T + b


def layer_norm(x, w, b, eps=1e-5):
    m = x.mean(-1, keepdims=True)
    v = ((x - m) ** 2).mean(-1, keepdims=True)
    return (x - m) / np.sqrt(v + eps) * w + b


def softmax(x):
    e = np.exp(x - x.max(-1, keepdims=True))
    return e / e.sum(-1, keepdims=True)


def mha(q_in, kv_in, mask, in_w, in_b, out_w, out_b, heads=4):
    """nn.MultiheadAttention(key=value=kv_in) con mascara aditiva (B, S). Devuelve (B, Lq, E)."""
    B, Lq, E = q_in.shape
    S = kv_in.shape[1]
    hd = E // heads
    q = linear(q_in, in_w[:E], in_b[:E])
    k = linear(kv_in, in_w[E:2 * E], in_b[E:2 * E])
    v = linear(kv_in, in_w[2 * E:], in_b[2 * E:])
    q = q.reshape(B, Lq, heads, hd).transpose(0, 2, 1, 3) / np.sqrt(hd)
    k = k.reshape(B, S, heads, hd).transpose(0, 2, 1, 3)
    v = v.reshape(B, S, heads, hd).transpose(0, 2, 1, 3)
    att = q @ k.transpose(0, 1, 3, 2) + mask[:, None, None, :]
    att = softmax(att)
    o = (att @ v).transpose(0, 2, 1, 3).reshape(B, Lq, E)
    return linear(o, out_w, out_b)
