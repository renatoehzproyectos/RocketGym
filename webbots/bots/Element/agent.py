import os

import numpy as np


class Agent:
    """Element sin PyTorch: el MLP original (model.p) exportado a element.npz."""

    def __init__(self, state_space: int, action_categoricals: int, action_bernoullis: int):
        self.state_space = state_space
        self.categoricals = action_categoricals
        self.bernoullis = action_bernoullis
        cur_dir = os.path.dirname(os.path.realpath(__file__))
        self.w = dict(np.load(os.path.join(cur_dir, "element.npz")))

    def act(self, state):
        w = self.w
        x = np.asarray(state, dtype=np.float32).reshape(-1, self.state_space)
        for i in range(1, 6):
            x = np.maximum(x @ w["fc%d.weight" % i].T + w["fc%d.bias" % i], 0.0)
        cat = (x @ w["cat_heads.weight"].T + w["cat_heads.bias"]).reshape(-1, self.categoricals, 3)
        ber = (x @ w["ber_heads.weight"].T + w["ber_heads.bias"]).reshape(-1, self.bernoullis, 2)
        # argmax(softmax(l)) == argmax(l)
        return np.concatenate([cat.argmax(2), ber.argmax(2)], axis=1)
