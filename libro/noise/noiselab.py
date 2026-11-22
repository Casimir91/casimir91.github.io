"""Helpers for the Noise chapter: a cooling cup of tea, three colours of noise, and the graphs that show them.

Plain Python and NumPy. Open this file next to the page if you want to see how a graph is drawn.
"""
import numpy as np
import matplotlib.pyplot as plt

BLUE, AMBER, GREEN, PURPLE = "#3B6FB6", "#EF9F27", "#1D9E75", "#7F77DD"
COLOUR = {"white": "#8A8F98", "pink": "#D4537E", "brown": "#9C6B3F"}

plt.rcParams.update({
    "figure.facecolor": "white", "axes.facecolor": "white",
    "axes.spines.top": False, "axes.spines.right": False,
    "axes.grid": True, "grid.color": "#e6e6e6", "axes.axisbelow": True,
    "font.size": 11, "lines.linewidth": 2.2, "lines.markersize": 6,
    "legend.frameon": False,
})


# ---------------------------------------------------------------- the cup and the noise

def seconds(total, every=10):
    """The times of the readings: 0, every, 2*every ... up to total (in seconds)."""
    return np.arange(0, total + every / 2, every, dtype=float)


def cooling(t, tau=200.0, start=78.0, room=20.0):
    """Newton's law of cooling: the true temperature of the tea. tau = how slowly it cools (s)."""
    return room + (start - room) * np.exp(-np.asarray(t, dtype=float) / tau)


def white(n, sigma=1.0):
    """n values of white noise: every value is new, nothing is remembered. sigma = its size."""
    return sigma * np.random.default_rng().normal(size=n)


def _coloured(n, beta, sigma):
    """Noise whose power goes as 1/f**beta: build its spectrum, then turn it back into a signal."""
    rng = np.random.default_rng()
    k = np.arange(1, n // 2 + 1)
    spec = np.zeros(n // 2 + 1, dtype=complex)
    spec[1:] = k ** (-beta / 2) * (rng.normal(size=k.size) + 1j * rng.normal(size=k.size))
    x = np.fft.irfft(spec, n)
    x = x - x.mean()
    return sigma * x / x.std()


def pink(n, sigma=1.0):
    """n values of pink noise (1/f): slow and fast swings, all scales at once."""
    return _coloured(n, 1.0, sigma)


def brown(n, sigma=1.0):
    """n values of brown noise (1/f squared): a random walk, every value starts from the last."""
    return _coloured(n, 2.0, sigma)


def memory(x):
    """r1: how well one value predicts the next. 0 = no memory, 1 = total memory."""
    x = np.asarray(x, dtype=float)
    return float(np.corrcoef(x[:-1], x[1:])[0, 1])


def _spectrum(x):
    """Power at each frequency f, averaged in bins that grow with f (log scale)."""
    x = np.asarray(x, dtype=float)
    power = np.abs(np.fft.rfft(x - x.mean())) ** 2 / x.size
    half = x.size // 2
    lf, lp, lo = [], [], 1
    while lo < half:
        hi = max(lo + 1, int(round(lo * 1.5)))
        k = np.arange(lo, min(hi, half))
        lf.append(np.log10(k).mean())
        lp.append(np.log10(power[k]).mean())
        lo = hi
    return np.array(lf), np.array(lp)


def slope(x):
    """Steepness of the spectrum on log-log axes: about 0 for white, -1 for pink, -2 for brown."""
    lf, lp = _spectrum(x)
    return float(np.polyfit(lf, lp, 1)[0])


# ---------------------------------------------------------------- graphs

def tidy(fig):
    """tight_layout, silent: if it cannot fit everything, use fixed margins instead."""
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        try:
            fig.tight_layout()
        except Exception:
            fig.subplots_adjust(left=0.1, right=0.96, bottom=0.15, top=0.9)


def chip(ax, text, colour, x=1, y=1.04):
    """A small coloured label above the top-right corner of a plot."""
    ax.text(x, y, text, transform=ax.transAxes, ha="right", va="bottom", color="white",
            fontsize=12, fontweight="bold", bbox=dict(boxstyle="round,pad=0.35", fc=colour, ec="none"))


def show_strips(t, signal, noise, reading):
    """The three strips: signal + noise = reading."""
    fig, axs = plt.subplots(3, 1, figsize=(7, 5.6), sharex=True)
    for a, y, c, name in zip(axs, (signal, noise, reading), (BLUE, AMBER, GREEN), ("signal", "noise", "reading")):
        if name == "signal":
            a.plot(t, y, color=c)
        else:
            a.plot(t, y, "o", color=c, markersize=4.5)
        a.set_ylabel(name, color=c, fontweight="bold")
    axs[1].axhline(0, color="gray", linestyle="--", linewidth=1)
    axs[2].set_xlabel("t (s)")
    axs[0].text(1.0, 0.92, "+", transform=axs[0].transAxes, ha="right", fontsize=18, color="gray")
    axs[1].text(1.0, 0.92, "=", transform=axs[1].transAxes, ha="right", fontsize=18, color="gray")
    tidy(fig)
    plt.show()


def show_noise(x):
    """Noise on its own: the values in time order (left) and how they are spread (right)."""
    s = float(np.std(x))
    top = 4 * max(s, 0.5)
    fig, (a, h) = plt.subplots(1, 2, figsize=(7, 3.6), sharey=True, gridspec_kw={"width_ratios": [4, 1.6]})
    a.axhspan(-s, s, color=AMBER, alpha=0.18)
    a.axhline(0, color="gray", linestyle="--", linewidth=1)
    a.plot(x[:80], "-o", color=AMBER, markersize=4, linewidth=1)
    a.set_ylim(-top, top)
    a.set_xlabel("reading number")
    a.set_ylabel("noise")
    chip(a, f"σ = {s:.2f}", AMBER)
    edges = np.linspace(-top, top, 28)
    h.hist(x, bins=edges, orientation="horizontal", color=AMBER, alpha=0.9)
    y = np.linspace(-top, top, 200)
    bell = x.size * (edges[1] - edges[0]) * np.exp(-y ** 2 / (2 * s ** 2)) / (s * np.sqrt(2 * np.pi))
    h.plot(bell, y, color="black", linewidth=1.5)
    h.axhspan(-s, s, color=AMBER, alpha=0.18)
    h.set_xticklabels([])
    h.set_xlabel("count")
    tidy(fig)
    plt.show()


def show_colour(x):
    """Noise, its memory plot (next value against this one) and its spectrum."""
    r, sl = memory(x), slope(x)
    lf, lp = _spectrum(x)
    fig = plt.figure(figsize=(7, 5.6))
    gs = fig.add_gridspec(2, 2, height_ratios=[1.1, 1.5])
    a = fig.add_subplot(gs[0, :])
    m = fig.add_subplot(gs[1, 0])
    p = fig.add_subplot(gs[1, 1])
    a.plot(x, color=AMBER, linewidth=1.3)
    a.axhline(0, color="gray", linestyle="--", linewidth=1)
    a.set_title("the noise over time", loc="left", fontsize=11)
    a.set_xlabel("reading number")
    m.plot(x[:-1], x[1:], "o", color=AMBER, alpha=0.5, markersize=3.5)
    lim = 1.1 * max(abs(x.min()), abs(x.max()))
    m.plot([-lim, lim], [-lim, lim], color="gray", linestyle="--", linewidth=1)
    m.set_xlim(-lim, lim)
    m.set_ylim(-lim, lim)
    m.set_xlabel("now")
    m.set_ylabel("next")
    m.set_title("memory", loc="left", fontsize=11)
    chip(m, f"r₁ {r:+.2f}", AMBER)
    p.plot(lf, lp, "o", color=AMBER)
    p.plot(lf, np.polyval(np.polyfit(lf, lp, 1), lf), "--", color="gray")
    p.set_xlabel("log f")
    p.set_ylabel("log power")
    p.set_title("spectrum", loc="left", fontsize=11)
    chip(p, f"slope {sl:+.1f}", AMBER)
    tidy(fig)
    plt.show()


def show_residuals(t, reading, model):
    """Readings with the model, and below them the leftovers: residual = reading - model."""
    res = np.asarray(reading) - np.asarray(model)
    r = memory(res)
    lim = 2 / np.sqrt(res.size)                       # about what pure chance gives with this many points
    ok = abs(r) <= lim
    fig, (a, b) = plt.subplots(2, 1, figsize=(7, 5.4), sharex=True, gridspec_kw={"height_ratios": [2.2, 1.4]})
    a.vlines(t, reading, model, color=PURPLE, linewidth=1.6)
    a.plot(t, model, color=BLUE, label="model")
    a.plot(t, reading, "o", color=GREEN, label="reading")
    a.set_ylabel("T (°C)")
    a.legend(loc="upper right")
    b.axhline(0, color="gray", linestyle="--", linewidth=1)
    b.vlines(t, 0, res, color=PURPLE, linewidth=1.6)
    b.plot(t, res, "o", color=PURPLE)
    b.set_xlabel("t (s)")
    b.set_ylabel("residual")
    chip(b, f"r₁ {r:+.2f}  " + ("no pattern" if ok else "a pattern"), "#1D9E75" if ok else "#D9534F")
    tidy(fig)
    plt.show()
