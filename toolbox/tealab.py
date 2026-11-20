"""Python Lab helpers: a cooling cup of tea, noise with and without memory, and the graphs that show them.

Plain Python, no magic: open this file next to the page if you want to see how a graph is drawn.
"""
import numpy as np
import matplotlib.pyplot as plt

COLORS = ["#004D43", "#E8A200", "#3A86C8", "#C8508B"]
GOOD, WARN, BAD = "#2E9E5B", "#E8A200", "#D9534F"

plt.rcParams.update({
    "figure.facecolor": "white", "axes.facecolor": "white",
    "axes.spines.top": False, "axes.spines.right": False,
    "axes.grid": True, "grid.color": "#e6e6e6", "axes.axisbelow": True,
    "font.size": 11, "lines.linewidth": 2.2, "lines.markersize": 6,
    "legend.frameon": False,
    "axes.prop_cycle": plt.cycler(color=COLORS),
})


def light(value, good, warn):
    """Traffic-light colour: green up to `good`, amber up to `warn`, red beyond."""
    return GOOD if value <= good else WARN if value <= warn else BAD


def tidy(fig):
    """tight_layout, silent: if it cannot fit everything, use fixed margins instead."""
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        try:
            fig.tight_layout()
        except Exception:
            fig.subplots_adjust(left=0.1, right=0.96, bottom=0.18, top=0.86)


def chip(ax, text, colour, x=1, y=1.04):
    """A small coloured label above the top-right corner of a plot."""
    ax.text(x, y, text, transform=ax.transAxes, ha="right", va="bottom", color="white",
            fontsize=12, fontweight="bold", bbox=dict(boxstyle="round,pad=0.35", fc=colour, ec="none"))


# ---------------------------------------------------------------- noise and data

def noise_series(n, sigma, memory=0.0, rng=None, size=None):
    """Random noise with standard deviation sigma.

    memory = 0    -> white noise: every value is independent of the one before.
    memory -> 1   -> every value remembers the previous one: the noise wanders slowly.
    The spread of the values stays sigma whatever the memory is.
    With size=m you get m independent series (a table m x n).
    """
    rng = rng or np.random.default_rng()
    rows = 1 if size is None else size
    w = rng.normal(0, 1, (rows, n))
    e = np.empty((rows, n))
    e[:, 0] = w[:, 0]
    k = np.sqrt(1 - memory ** 2)
    for i in range(1, n):
        e[:, i] = memory * e[:, i - 1] + k * w[:, i]
    e = sigma * e
    return e[0] if size is None else e


def tea(noise=0.4, interval=15, cooling_time=240, Ta=21.0, T0=78.0, seed=7, memory=0.0, step=0.0):
    """Fake measurements of a cooling cup of tea.

    noise: how much each reading wobbles (°C).   interval: seconds between two readings.
    cooling_time: how slowly the tea cools (s), the number the fit has to find.
    memory: 0 = white noise.   step: thermometer resolution (0 = none).
    """
    rng = np.random.default_rng(seed)
    t = np.arange(0, 600, float(interval))
    T = Ta + (T0 - Ta) * np.exp(-t / cooling_time) + noise_series(t.size, noise, memory, rng)
    if step > 0:
        T = np.round(T / step) * step      # a digital thermometer shows steps, not every value
    return t, T


# ---------------------------------------------------------------- graphs

def show(t, T, sigma, model, par, cov):
    """Draw data with error bars, the fitted curve, and the residuals. The chip is the reduced chi-squared."""
    err = np.sqrt(np.diag(cov))
    res = T - model(t, *par)
    chi2 = np.sum((res / sigma) ** 2) / (t.size - len(par))
    # traffic light: around 1 is a fit that matches the error bars
    colour = GOOD if 0.5 <= chi2 <= 1.6 else WARN if chi2 <= 3 else BAD

    tt = np.linspace(t.min(), t.max(), 300)
    fig, (a, b) = plt.subplots(2, 1, figsize=(7, 5.2), sharex=True,
                               gridspec_kw={"height_ratios": [3, 1.5]})
    a.errorbar(t, T, yerr=sigma, fmt="o", capsize=3, label="data")
    a.plot(tt, model(tt, *par), label="fit")
    a.set_ylabel("T (°C)")
    a.legend(loc="upper right", bbox_to_anchor=(1, 0.82))
    a.set_title(f"τ = {par[2]:.0f} ± {err[2]:.0f} s", loc="left", fontsize=14)
    chip(a, f"χ² {chi2:.2f}", colour)

    b.axhline(0, color="gray")
    b.fill_between(t, -sigma, sigma, alpha=0.15)
    b.errorbar(t, res, yerr=sigma, fmt="o", capsize=3)
    b.set_xlabel("t (s)")
    b.set_ylabel("data − fit")
    tidy(fig)
    plt.show()


def look(t, T, sigma, model, par, cov):
    """The noise itself: residuals in time order (left) and how their values are spread (right).

    The chip is the memory of the noise: how much a residual resembles the one before (r1).
    """
    err = np.sqrt(np.diag(cov))
    res = T - model(t, *par)
    r1 = np.corrcoef(res[:-1], res[1:])[0, 1]
    lim = 2 / np.sqrt(res.size)                 # about what pure chance gives with this many points
    colour = light(abs(r1), lim, 2 * lim)
    top = 3.0

    fig, (a, h) = plt.subplots(1, 2, figsize=(7, 3.6), sharey=True,
                               gridspec_kw={"width_ratios": [4, 1.3]})
    a.axhline(0, color="gray")
    a.fill_between([t.min(), t.max()], -sigma, sigma, alpha=0.15)
    a.plot(t, res, "-o", markersize=5, linewidth=1.2)
    a.set_ylim(-top, top)
    a.set_xlabel("t (s)")
    a.set_ylabel("noise (°C)")
    a.set_title(f"τ = {par[2]:.0f} ± {err[2]:.0f} s", loc="left", fontsize=13)
    chip(a, f"memory r₁ {r1:+.2f}", colour)

    edges = np.linspace(-top, top, 22)
    h.hist(res, bins=edges, orientation="horizontal", color=COLORS[0], alpha=0.85)
    y = np.linspace(-top, top, 200)
    bell = res.size * (edges[1] - edges[0]) * np.exp(-y ** 2 / (2 * sigma ** 2)) / (sigma * np.sqrt(2 * np.pi))
    h.plot(bell, y, color=COLORS[1])
    h.set_xticklabels([])
    h.set_xlabel("count")
    tidy(fig)
    plt.show()


def spread(taus, claimed):
    """Many repeats of the experiment: what the fit claimed versus how τ really scattered."""
    taus = np.asarray(taus)
    real = taus.std(ddof=1)
    said = float(np.mean(claimed))
    ratio = real / said
    colour = light(ratio, 1.3, 1.8)

    fig, a = plt.subplots(figsize=(7, 3.8))
    a.hist(taus, bins=16, color=COLORS[0], alpha=0.85)
    top = a.get_ylim()[1]
    m = taus.mean()
    a.errorbar([m], [top * 1.12], xerr=[said], fmt="none", ecolor=COLORS[1], elinewidth=5, capsize=7, capthick=3)
    a.errorbar([m], [top * 1.30], xerr=[real], fmt="none", ecolor=COLORS[3], elinewidth=5, capsize=7, capthick=3)
    for w, y, name, c in ((said, 1.12, "fit says", COLORS[1]), (real, 1.30, "really", COLORS[3])):
        a.annotate(name, (m + w, top * y), xytext=(10, 0), textcoords="offset points",
                   va="center", color=c, annotation_clip=False)
    half = max(said, real, taus.max() - m, m - taus.min())
    a.set_xlim(m - 1.15 * half, m + 1.6 * half)
    a.set_ylim(0, top * 1.45)
    a.set_yticks([])
    a.set_xlabel("τ found by the fit (s)")
    a.set_title(f"{taus.size} repeats", loc="left", fontsize=13)
    chip(a, f"really ÷ fit says  ×{ratio:.1f}", colour)
    tidy(fig)
    plt.show()


def average(memory, sigma=0.4, sims=200, n_max=256, seed=1):
    """A thermometer in a bath at constant temperature: how much does averaging N readings help?"""
    rng = np.random.default_rng(seed)
    x = noise_series(n_max, sigma, memory, rng, size=sims)
    Ns = 2 ** np.arange(0, int(np.log2(n_max)) + 1)
    got = np.array([x[:, :n].mean(axis=1).std() for n in Ns])
    promise = sigma / np.sqrt(Ns)                 # what white noise would give
    ratio = got[-1] / promise[-1]
    colour = light(ratio, 1.3, 2)

    fig, a = plt.subplots(figsize=(7, 4.2))
    a.loglog(Ns, promise, "--", color="gray", label="white noise: σ/√N")
    a.loglog(Ns, got, "-o", label="this noise")
    a.set_xticks(Ns)
    a.set_xticklabels([str(n) for n in Ns])
    a.xaxis.set_minor_formatter(plt.NullFormatter())
    lo, hi = a.get_ylim()
    a.set_yticks([v for v in (0.01, 0.02, 0.05, 0.1, 0.2, 0.5) if lo <= v <= hi])
    a.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"{v:g}"))
    a.yaxis.set_minor_formatter(plt.NullFormatter())
    a.set_xlabel("N readings averaged")
    a.set_ylabel("error of the average (°C)")
    a.legend(loc="lower left")
    chip(a, f"N = {Ns[-1]}: ×{ratio:.1f}", colour)
    tidy(fig)
    plt.show()
