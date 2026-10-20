import math
import os

import numpy as np

from npnn import relu, linear, layer_norm, softmax, mha


class Agent:
    """Nexto sin PyTorch: el modelo TorchScript original (nexto-model.pt) exportado a nexto.npz."""

    def __init__(self):
        cur_dir = os.path.dirname(os.path.realpath(__file__))
        self.w = dict(np.load(os.path.join(cur_dir, "nexto.npz")))
        self._lookup_table = self.make_lookup_table()
        self.state = None
        w = self.w
        # Embedding de todas las acciones (constante: no depende de la observacion)
        h = relu(linear(w["table"], w["net.output.net.0.weight"], w["net.output.net.0.bias"]))
        h = relu(linear(h, w["net.output.net.2.weight"], w["net.output.net.2.bias"]))
        self._act_emb = relu(linear(h, w["net.output.net.4.weight"], w["net.output.net.4.bias"]))  # (90, 32)

    @staticmethod
    def make_lookup_table():
        actions = []
        # Ground
        for throttle in (-1, 0, 1):
            for steer in (-1, 0, 1):
                for boost in (0, 1):
                    for handbrake in (0, 1):
                        if boost == 1 and throttle != 1:
                            continue
                        actions.append([throttle or boost, steer, 0, steer, 0, 0, boost, handbrake])
        # Aerial
        for pitch in (-1, 0, 1):
            for yaw in (-1, 0, 1):
                for roll in (-1, 0, 1):
                    for jump in (0, 1):
                        for boost in (0, 1):
                            if jump == 1 and yaw != 0:  # Only need roll for sideflip
                                continue
                            if pitch == roll == jump == 0:  # Duplicate with ground
                                continue
                            # Enable handbrake for potential wavedashes
                            handbrake = jump == 1 and (pitch != 0 or yaw != 0 or roll != 0)
                            actions.append([boost, yaw, pitch, yaw, roll, jump, boost, handbrake])
        return np.array(actions)

    def _forward(self, q, kv, mask):
        w = self.w
        p = "net.earl."
        x = relu(linear(q, w[p + "query_preprocess.0.weight"], w[p + "query_preprocess.0.bias"]))
        x = relu(linear(x, w[p + "query_preprocess.2.weight"], w[p + "query_preprocess.2.bias"]))
        k = relu(linear(kv, w[p + "key_value_preprocess.0.weight"], w[p + "key_value_preprocess.0.bias"]))
        k = relu(linear(k, w[p + "key_value_preprocess.2.weight"], w[p + "key_value_preprocess.2.bias"]))
        for i in range(2):
            b = "%sblocks.%d." % (p, i)
            xn = layer_norm(x, w[b + "norm1.weight"], w[b + "norm1.bias"])
            kn = layer_norm(k, w[b + "norm2.weight"], w[b + "norm2.bias"])
            a = mha(xn, kn, mask, w[b + "attention.in_proj_weight"], w[b + "attention.in_proj_bias"],
                    w[b + "attention.out_proj.weight"], w[b + "attention.out_proj.bias"])
            x = x + a
            h = relu(linear(layer_norm(x, w[b + "norm3.weight"], w[b + "norm3.bias"]),
                            w[b + "linear1.weight"], w[b + "linear1.bias"]))
            x = x + linear(h, w[b + "linear2.weight"], w[b + "linear2.bias"])
        x = relu(x)
        emb = linear(x, w["net.output.emb_convertor.weight"], w["net.output.emb_convertor.bias"])  # (B,1,32)
        return (emb @ self._act_emb.T)[:, 0, :]  # (B, 90)

    def act(self, state, beta):
        q, kv, mask = (np.asarray(s, dtype=np.float32) for s in state)
        logits = self._forward(q, kv, mask)[0].astype(np.float64)
        self.state = state

        if beta == 1:
            a = int(np.argmax(logits))
        elif beta == -1:
            a = int(np.argmin(logits))
        else:
            if beta == 0:
                logits = np.zeros_like(logits)
            else:
                logits = logits * math.log((beta + 1) / (1 - beta), 3)
            p = softmax(logits)
            a = int(np.random.choice(len(p), p=p / p.sum()))
        return self._lookup_table[a], None
