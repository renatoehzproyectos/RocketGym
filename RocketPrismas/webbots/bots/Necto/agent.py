import math
import os

import numpy as np

from npnn import relu, linear, softmax, mha


class Agent:
    """Necto sin PyTorch: el modelo TorchScript original (necto-model.pt) exportado a necto.npz."""

    SPLITS = (3, 3, 2, 2, 2)

    def __init__(self):
        cur_dir = os.path.dirname(os.path.realpath(__file__))
        self.w = dict(np.load(os.path.join(cur_dir, "necto.npz")))

    def _forward(self, q, kv, mask):
        w = self.w
        p = "net.earl."
        x = relu(linear(q, w[p + "query_preprocess.0.weight"], w[p + "query_preprocess.0.bias"]))
        x = relu(linear(x, w[p + "query_preprocess.2.weight"], w[p + "query_preprocess.2.bias"]))
        k = relu(linear(kv, w[p + "key_value_preprocess.0.weight"], w[p + "key_value_preprocess.0.bias"]))
        k = relu(linear(k, w[p + "key_value_preprocess.2.weight"], w[p + "key_value_preprocess.2.bias"]))
        b = p + "blocks.0."
        x = x + mha(x, k, mask, w[b + "attention.in_proj_weight"], w[b + "attention.in_proj_bias"],
                    w[b + "attention.out_proj.weight"], w[b + "attention.out_proj.bias"])
        x = x + linear(relu(linear(x, w[b + "linear1.weight"], w[b + "linear1.bias"])),
                       w[b + "linear2.weight"], w[b + "linear2.bias"])
        x = relu(x)
        return linear(x, w["net.output.linear.weight"], w["net.output.linear.bias"])[0, 0]  # (12,)

    def act(self, state, beta):
        q, kv, mask = (np.asarray(s, dtype=np.float32) for s in state)
        flat = self._forward(q, kv, mask).astype(np.float64)
        heads, i = [], 0
        for n in self.SPLITS:
            heads.append(flat[i:i + n]); i += n

        actions = np.zeros(5, dtype=np.int64)
        for j, l in enumerate(heads):
            if beta == 1:
                actions[j] = np.argmax(l)
            elif beta == -1:
                actions[j] = np.argmin(l)
            else:
                if beta == 0:
                    l = np.zeros_like(l)
                else:
                    l = l * math.log((beta + 1) / (1 - beta), 3)
                p = softmax(l)
                actions[j] = np.random.choice(len(p), p=p / p.sum())
        actions = actions.reshape((-1, 5))
        actions[:, 0] = actions[:, 0] - 1
        actions[:, 1] = actions[:, 1] - 1

        parsed = np.zeros((actions.shape[0], 8))
        parsed[:, 0] = actions[:, 0]  # throttle
        parsed[:, 1] = actions[:, 1]  # steer
        parsed[:, 2] = actions[:, 0]  # pitch
        parsed[:, 3] = actions[:, 1] * (1 - actions[:, 4])  # yaw
        parsed[:, 4] = actions[:, 1] * actions[:, 4]  # roll
        parsed[:, 5] = actions[:, 2]  # jump
        parsed[:, 6] = actions[:, 3]  # boost
        parsed[:, 7] = actions[:, 4]  # handbrake
        return parsed[0], None
