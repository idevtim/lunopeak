use crate::models::TokenUsage;

/// Anthropic public list prices in USD per **1M tokens**. Audited in full
/// against platform.claude.com/docs/en/about-claude/pricing on 2026-10-07 —
/// update whenever pricing shifts.
struct Price {
    input: f64,
    output: f64,
    cache_read: f64,
    cache_creation: f64,    // 5m ephemeral cache write
    cache_creation_1h: f64, // 1h ephemeral cache write
}

// Fable 5 list pricing: $10 / $50 per 1M (cache hit 0.1×, 5m write 1.25×, 1h write 2×).
// Flat across the full 1M context — no extended-context tier published.
// Also the fallback tier for the Mythos line (Project Glasswing), which is
// Fable priced — see `lookup`.
const FABLE: Price = Price {
    input: 10.0,
    output: 50.0,
    cache_read: 1.0,
    cache_creation: 12.50,
    cache_creation_1h: 20.0,
};

// Fable 5.1 and Mythos 5.1 succeed Fable 5 / Mythos 5 in the same tier at the
// same per-token price — $10 / $50, 5m write $12.50, 1h write $20 — with one
// change: cache reads bill at $0.25 per 1M, i.e. 0.025× input rather than the
// 0.1× most models charge. That's a quarter of the Fable 5 rate, so a long
// agentic session that keeps re-reading a warm prefix gets most of the
// saving. Still flat across the full 1M context. (Mythos 5.1's cache-read
// rate was left open at launch; the pricing page confirmed 0.025× by
// 2026-10-07.)
const FABLE_5_1: Price = Price {
    input: 10.0,
    output: 50.0,
    cache_read: 0.25,
    cache_creation: 12.50,
    cache_creation_1h: 20.0,
};

// Opus 4.5–4.8 and Opus 5 list pricing: $5 / $25 per 1M (cache hit 0.1×, 5m
// write 1.25×, 1h write 2×). Flat across the full context window: Anthropic
// bills every Claude 4.6+ model's 1M context at standard rates, and Opus 4.5
// tops out at 200k, so no Opus in this tier has an extended-context premium.
const OPUS_MODERN: Price = Price {
    input: 5.0,
    output: 25.0,
    cache_read: 0.50,
    cache_creation: 6.25,
    cache_creation_1h: 10.0,
};

// Opus 5.5 succeeds Opus 5 at a lower price: $4 / $20 per 1M, 5m write $5
// (1.25×), 1h write $8 (2×), and cache reads at $0.20 — 0.05× input rather
// than the standard 0.1×, so like Fable 5.1 it reports a cache-read saving.
// Flat across its full 1M context, same as Opus 5.
const OPUS_5_5: Price = Price {
    input: 4.0,
    output: 20.0,
    cache_read: 0.20,
    cache_creation: 5.0,
    cache_creation_1h: 8.0,
};

// Opus 4.1, 4.0, and 3.x (legacy $15 / $75 tier).
const OPUS_LEGACY: Price = Price {
    input: 15.0,
    output: 75.0,
    cache_read: 1.50,
    cache_creation: 18.75,
    cache_creation_1h: 30.0,
};

// Sonnet 4, 4.5 and 4.6 ($3 / $15 list).
const SONNET: Price = Price {
    input: 3.0,
    output: 15.0,
    cache_read: 0.30,
    cache_creation: 3.75,
    cache_creation_1h: 6.0,
};

// Sonnet 5 and Sonnet 5.5: $2 / $10, with the standard 0.1× / 1.25× / 2× cache
// multipliers. Sonnet 5 launched at this price as an "introductory" rate due
// to revert to $3 / $15 on 2026-09-01; Anthropic cancelled that increase, so
// it is simply the price now, for every date.
//
// Sonnet 5.5's cache read is $0.20 (0.1×) per the pricing table and the
// models overview. The prompt-caching section of the pricing page claims
// 0.05× ($0.10) instead; until the two agree we take the higher rate, so a
// budget alert never under-reports a real bill.
const SONNET_5: Price = Price {
    input: 2.0,
    output: 10.0,
    cache_read: 0.20,
    cache_creation: 2.50,
    cache_creation_1h: 4.0,
};

// Haiku 5.5 is priced by prompt length. Prompts up to 100k tokens bill at
// $0.10 / $0.50 per 1M (standard 0.1× / 1.25× / 2× cache multipliers)...
const HAIKU_5_5: Price = Price {
    input: 0.10,
    output: 0.50,
    cache_read: 0.01,
    cache_creation: 0.125,
    cache_creation_1h: 0.20,
};

// ...and a prompt over 100k tokens bills the whole turn at 5× that:
// $0.50 / $2.50, same multipliers. See `cost_of` for what counts as the prompt.
const HAIKU_5_5_LONG: Price = Price {
    input: 0.50,
    output: 2.50,
    cache_read: 0.05,
    cache_creation: 0.625,
    cache_creation_1h: 1.0,
};

/// Prompts above this many tokens move Haiku 5.5 to `HAIKU_5_5_LONG`.
const HAIKU_5_5_LONG_THRESHOLD: u64 = 100_000;

// Haiku 4.5.
const HAIKU_4_5: Price = Price {
    input: 1.0,
    output: 5.0,
    cache_read: 0.10,
    cache_creation: 1.25,
    cache_creation_1h: 2.0,
};

// Haiku 3.5 and earlier (legacy tier).
const HAIKU_LEGACY: Price = Price {
    input: 0.80,
    output: 4.0,
    cache_read: 0.08,
    cache_creation: 1.0,
    cache_creation_1h: 1.60,
};

/// Opus 4.5–4.8 — the modern $5 / $25 tier.
fn is_opus_modern(m: &str) -> bool {
    m.contains("opus")
        && ["4-5", "4.5", "4-6", "4.6", "4-7", "4.7", "4-8", "4.8"]
            .iter()
            .any(|v| m.contains(&format!("opus-{v}")))
}

/// Opus 5 (any snapshot). Shares the modern $5 / $25 rates but has no
/// published extended-context tier, so it never takes the >200k premium.
/// Safe against Opus 4.5: `opus-5` is not a substring of `opus-4-5`. Also
/// matches Opus 5.5, so `lookup` checks `is_opus_5_5` first.
fn is_opus_5(m: &str) -> bool {
    m.contains("opus-5")
}

/// Opus 5.5 (any snapshot). The dotted form covers slugs that survive a
/// display round-trip ("claude-opus-5.5").
fn is_opus_5_5(m: &str) -> bool {
    m.contains("opus-5-5") || m.contains("opus-5.5")
}

/// Sonnet 5 and 5.5 (any snapshot) — they share a price. Safe against Sonnet
/// 4.5: `sonnet-5` is not a substring of `sonnet-4-5`.
fn is_sonnet_5(m: &str) -> bool {
    m.contains("sonnet-5")
}

/// Haiku 5.5 (any snapshot). The dotted form covers slugs that survive a
/// display round-trip ("claude-haiku-5.5").
fn is_haiku_5_5(m: &str) -> bool {
    m.contains("haiku-5-5") || m.contains("haiku-5.5")
}

/// Fable 5.1 (any snapshot). Matched on the full `fable-5-1` suffix so plain
/// `fable-5` can't be mistaken for it, and checked before the bare Fable
/// branch in `lookup`. The dotted form covers slugs that survive a display
/// round-trip ("claude-fable-5.1").
fn is_fable_5_1(m: &str) -> bool {
    m.contains("fable-5-1") || m.contains("fable-5.1")
}

/// Mythos 5.1 (any snapshot) — priced exactly as Fable 5.1.
fn is_mythos_5_1(m: &str) -> bool {
    m.contains("mythos-5-1") || m.contains("mythos-5.1")
}

fn lookup(m: &str) -> Price {
    // The Mythos line (Project Glasswing) is the Fable tier under a different
    // name — Mythos 5 mirrors Fable 5 and Mythos 5.1 mirrors Fable 5.1 — so
    // both slugs resolve here rather than falling through to the Sonnet
    // default, which would under-report them by more than 3×.
    if m.contains("fable") || m.contains("mythos") {
        if is_fable_5_1(m) || is_mythos_5_1(m) {
            FABLE_5_1
        } else {
            FABLE
        }
    } else if m.contains("opus") {
        if is_opus_5_5(m) {
            OPUS_5_5
        } else if is_opus_5(m) || is_opus_modern(m) {
            OPUS_MODERN
        } else {
            OPUS_LEGACY
        }
    } else if m.contains("haiku") {
        // Haiku 5.5 (short-prompt rate here; `cost_of` applies the long tier),
        // then 4.5. 3.5 and earlier stay on the legacy tier.
        if is_haiku_5_5(m) {
            HAIKU_5_5
        } else if m.contains("haiku-4") {
            HAIKU_4_5
        } else {
            HAIKU_LEGACY
        }
    } else if is_sonnet_5(m) {
        SONNET_5
    } else {
        // Default to Sonnet pricing for unknown / "claude-sonnet-4-*" / "claude-3-5-*"
        SONNET
    }
}

/// USD cost for one assistant turn. `ts_millis` is the turn's epoch-millis
/// timestamp. No Anthropic rate is time-boxed today (Sonnet 5's intro window
/// became its permanent price), but callers keep passing it so a future
/// dated change slots in here without touching the scanners.
pub fn cost_of(model: &str, usage: &TokenUsage, _ts_millis: Option<i64>) -> f64 {
    let m = model.to_ascii_lowercase();

    // The "prompt size" for Haiku 5.5's length tier is the whole input side
    // of the request: fresh input + cache reads + cache writes.
    let prompt_tokens = usage.input + usage.cache_read + usage.cache_creation;
    let p = if is_haiku_5_5(&m) && prompt_tokens > HAIKU_5_5_LONG_THRESHOLD {
        HAIKU_5_5_LONG
    } else {
        lookup(&m)
    };

    // cache_creation is the 5m+1h total; split out the 1h portion so each
    // bills at its own rate.
    let cache_1h = usage.cache_creation_1h.min(usage.cache_creation);
    let cache_5m = usage.cache_creation - cache_1h;

    let m = 1_000_000.0;
    (usage.input as f64) * p.input / m
        + (usage.output as f64) * p.output / m
        + (usage.cache_read as f64) * p.cache_read / m
        + (cache_5m as f64) * p.cache_creation / m
        + (cache_1h as f64) * p.cache_creation_1h / m
}

/// USD saved on `cache_read_tokens` by the discounted cache-read rate the
/// model carries, versus what the same tokens would have cost on the standard
/// 0.1× rate for its tier. Returns 0.0 for every model that doesn't carry a
/// discount, so callers can total it unconditionally.
///
/// Today three models qualify: Fable 5.1 and Mythos 5.1 ($0.25 per 1M against
/// the $1.00 standard for their tier) and Opus 5.5 ($0.20 against $0.40).
/// Keeping the comparison in this module means the UI never has to hard-code
/// a rate to describe the saving.
pub fn cache_read_savings_usd(model: &str, cache_read_tokens: u64) -> f64 {
    let m = model.to_ascii_lowercase();
    let discounted = lookup(&m);
    // The tier's standard cache-read rate is 0.1× its input rate. Anything at
    // or above that isn't a discount worth reporting.
    let standard = discounted.input * 0.1;
    if discounted.cache_read >= standard {
        return 0.0;
    }
    (cache_read_tokens as f64) * (standard - discounted.cache_read) / 1_000_000.0
}

// ── OpenAI / Codex pricing ─────────────────────────────────────────────
//
// OpenAI public list prices in USD per 1M tokens, verified against
// developers.openai.com/api/docs/models on 2026-07-31. Cached input is the
// price for tokens served from the prompt cache (a subset of the total
// input the API reports). Codex JSONL reports `input_tokens` as the
// *total* prompt tokens (cached + uncached), so callers must split them
// before invoking `openai_cost_of`.
//
// Not modelled: the >272k-input long-context surcharge (2× input, 1.5×
// output) that gpt-5.5 and the gpt-5.6 family carry. It is a *per-request*
// tier, and the Codex scanner only ever hands us cumulative session totals
// (see `scanners::codex`) — a long session crosses 272k of lifetime prompt
// tokens without any single prompt getting close, so applying the tier here
// would systematically overcharge. Better to under-report than to invent a
// premium that was probably never billed.

struct OpenAiPrice {
    input: f64,
    cached_input: f64,
    output: f64,
}

// GPT-5.6 Sol — flagship of the 5.6 family, and what the bare `gpt-5.6`
// alias resolves to.
const GPT_5_6_SOL: OpenAiPrice = OpenAiPrice {
    input: 5.0,
    cached_input: 0.50,
    output: 30.0,
};

// GPT-5.6 Terra (balanced tier) at its post-2026-07-30 rates.
const GPT_5_6_TERRA: OpenAiPrice = OpenAiPrice {
    input: 2.0,
    cached_input: 0.20,
    output: 12.0,
};

// GPT-5.6 Terra as launched (2026-06-26 preview through 2026-07-29), before
// the 20% cut.
const GPT_5_6_TERRA_LAUNCH: OpenAiPrice = OpenAiPrice {
    input: 2.50,
    cached_input: 0.25,
    output: 15.0,
};

// GPT-5.6 Luna (high-volume tier) at its post-2026-07-30 rates.
const GPT_5_6_LUNA: OpenAiPrice = OpenAiPrice {
    input: 0.20,
    cached_input: 0.02,
    output: 1.20,
};

// GPT-5.6 Luna as launched, before the 80% cut.
const GPT_5_6_LUNA_LAUNCH: OpenAiPrice = OpenAiPrice {
    input: 1.0,
    cached_input: 0.10,
    output: 6.0,
};

// 2026-07-30T00:00:00Z in epoch millis — the first instant the reduced
// Terra / Luna rates apply. Usage strictly before this bills at the launch
// rates above. As with the Sonnet 5 window, UTC midnight is a deliberate
// approximation; sub-day precision is irrelevant for a local estimate.
const GPT_5_6_PRICE_CUT_MS: i64 = 1_785_369_600_000;

const GPT_5_5: OpenAiPrice = OpenAiPrice {
    input: 5.0,
    cached_input: 0.50,
    output: 30.0,
};

// gpt-5.5-pro / gpt-5.4-pro. OpenAI publishes no cached-input rate for the
// pro tiers (they don't serve prompt-cache hits), so cached tokens bill at
// the full input rate rather than a discount we'd be inventing.
const GPT_PRO: OpenAiPrice = OpenAiPrice {
    input: 30.0,
    cached_input: 30.0,
    output: 180.0,
};

const GPT_5_4: OpenAiPrice = OpenAiPrice {
    input: 2.50,
    cached_input: 0.25,
    output: 15.0,
};

const GPT_5_4_MINI: OpenAiPrice = OpenAiPrice {
    input: 0.75,
    cached_input: 0.075,
    output: 4.50,
};

// gpt-5.4-nano is 4× the price of the original gpt-5-nano — it must not
// fall through to the generic `nano` branch.
const GPT_5_4_NANO: OpenAiPrice = OpenAiPrice {
    input: 0.20,
    cached_input: 0.02,
    output: 1.25,
};

// gpt-5.3-codex and gpt-5.2-codex share a tier.
const CODEX_5_3: OpenAiPrice = OpenAiPrice {
    input: 1.75,
    cached_input: 0.175,
    output: 14.0,
};

const CODEX_MAX_5_1: OpenAiPrice = OpenAiPrice {
    input: 1.25,
    cached_input: 0.125,
    output: 10.0,
};

const GPT_5: OpenAiPrice = OpenAiPrice {
    input: 1.25,
    cached_input: 0.125,
    output: 10.0,
};

const GPT_5_MINI: OpenAiPrice = OpenAiPrice {
    input: 0.25,
    cached_input: 0.025,
    output: 2.0,
};

const GPT_5_NANO: OpenAiPrice = OpenAiPrice {
    input: 0.05,
    cached_input: 0.005,
    output: 0.40,
};

/// Resolve a model slug to its rate card. `ts_millis` selects between
/// time-boxed rates (currently the 2026-07-30 Terra / Luna cut); `None`
/// means "unknown date", which takes the current rates.
///
/// Order matters: the codex and pro tiers are matched before the version
/// families so `gpt-5.1-codex-max` and `gpt-5.5-pro` don't get swallowed,
/// and each family's mini / nano variants are matched before the bare
/// version so `gpt-5.4-nano` doesn't land on legacy `gpt-5-nano` rates.
fn openai_lookup(model: &str, ts_millis: Option<i64>) -> OpenAiPrice {
    let m = model.to_ascii_lowercase();
    let v = |s: &str| m.contains(s);
    let ver = |dotted: &str, dashed: &str| v(dotted) || v(dashed);
    // Terra and Luna got cheaper from 2026-07-30 onward; a turn with no
    // timestamp bills at today's rates rather than guessing backward.
    // `map_or(true, …)` rather than `is_none_or`: the latter needs Rust 1.82
    // and this crate declares `rust-version = "1.77"`.
    #[allow(clippy::unnecessary_map_or)]
    let cut = ts_millis.map_or(true, |t| t >= GPT_5_6_PRICE_CUT_MS);

    if v("codex-max") {
        CODEX_MAX_5_1
    } else if v("codex") && (ver("5.3", "5-3") || ver("5.2", "5-2")) {
        CODEX_5_3
    } else if v("-pro") {
        GPT_PRO
    } else if ver("5.6", "5-6") {
        if v("terra") {
            if cut {
                GPT_5_6_TERRA
            } else {
                GPT_5_6_TERRA_LAUNCH
            }
        } else if v("luna") {
            if cut {
                GPT_5_6_LUNA
            } else {
                GPT_5_6_LUNA_LAUNCH
            }
        } else {
            // gpt-5.6 and gpt-5.6-sol both bill at the flagship tier.
            GPT_5_6_SOL
        }
    } else if ver("5.5", "5-5") {
        GPT_5_5
    } else if ver("5.4", "5-4") {
        if v("mini") {
            GPT_5_4_MINI
        } else if v("nano") {
            GPT_5_4_NANO
        } else {
            GPT_5_4
        }
    } else if v("nano") {
        GPT_5_NANO
    } else if v("mini") {
        GPT_5_MINI
    } else {
        // Default to GPT-5 pricing for unknown / gpt-5 / gpt-5-codex.
        GPT_5
    }
}

/// USD cost for a Codex turn. `usage.input` is the *uncached* prompt
/// portion, `usage.cache_read` the cached prompt portion. `ts_millis` is the
/// turn's epoch-millis timestamp, used for time-boxed rates; pass `None`
/// when the date is unknown.
pub fn openai_cost_of(model: &str, usage: &TokenUsage, ts_millis: Option<i64>) -> f64 {
    let p = openai_lookup(model, ts_millis);
    let m = 1_000_000.0;
    (usage.input as f64) * p.input / m
        + (usage.cache_read as f64) * p.cached_input / m
        + (usage.output as f64) * p.output / m
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(input: u64, output: u64, cache_read: u64, cc: u64, cc_1h: u64) -> TokenUsage {
        TokenUsage {
            input,
            output,
            cache_read,
            cache_creation: cc,
            cache_creation_1h: cc_1h,
        }
    }

    fn approx(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-9, "expected {b}, got {a}");
    }

    // 2026-07-01T00:00:00Z — inside what was Sonnet 5's intro window.
    const JULY_TS: i64 = 1_782_864_000_000;
    // 2026-09-01T00:00:00Z — when the cancelled Sonnet 5 increase would have hit.
    const SEPT_TS: i64 = 1_788_220_800_000;

    #[test]
    fn opus_modern_base_rates() {
        // Sub-threshold prompt: 100k input + 100k output at $5 / $25.
        approx(
            cost_of("claude-opus-4-8", &usage(100_000, 100_000, 0, 0, 0), None),
            3.0,
        );
        // 4.5/4.6/4.7 share the tier.
        approx(
            cost_of("claude-opus-4-5", &usage(100_000, 0, 0, 0, 0), None),
            0.5,
        );
    }

    #[test]
    fn opus_5_flat_rates() {
        // Opus 5 shares the $5 / $25 tier: 100k in + 100k out = $0.50 + $2.50.
        approx(
            cost_of("claude-opus-5", &usage(100_000, 100_000, 0, 0, 0), None),
            3.0,
        );
        // Cache: read 0.1× ($0.50), 5m write 1.25× ($6.25), 1h write 2× ($10).
        approx(
            cost_of("claude-opus-5", &usage(0, 0, 1_000_000, 0, 0), None),
            0.50,
        );
        approx(
            cost_of("claude-opus-5", &usage(0, 0, 0, 1_000_000, 0), None),
            6.25,
        );
        approx(
            cost_of("claude-opus-5", &usage(0, 0, 0, 1_000_000, 1_000_000), None),
            10.0,
        );
        // No extended-context premium — flat rate above 200k, unlike Opus 4.8.
        approx(
            cost_of("claude-opus-5", &usage(300_000, 0, 0, 0, 0), None),
            1.50,
        );
        // Opus 4.5 must not be swallowed by the `opus-5` match.
        approx(
            cost_of("claude-opus-4-5", &usage(300_000, 0, 0, 0, 0), None),
            1.50,
        );
    }

    #[test]
    fn opus_5_5_rates() {
        // $4 / $20 per 1M: 100k in + 100k out = $0.40 + $2.00.
        approx(
            cost_of("claude-opus-5-5", &usage(100_000, 100_000, 0, 0, 0), None),
            2.40,
        );
        // Cache: read 0.05× ($0.20), 5m write 1.25× ($5), 1h write 2× ($8).
        approx(
            cost_of("claude-opus-5-5", &usage(0, 0, 1_000_000, 0, 0), None),
            0.20,
        );
        approx(
            cost_of("claude-opus-5-5", &usage(0, 0, 0, 1_000_000, 0), None),
            5.0,
        );
        approx(
            cost_of("claude-opus-5-5", &usage(0, 0, 0, 1_000_000, 1_000_000), None),
            8.0,
        );
        // Flat above 200k — no extended-context premium.
        approx(
            cost_of("claude-opus-5-5", &usage(300_000, 0, 0, 0, 0), None),
            1.20,
        );
        // Dotted slug resolves the same; plain Opus 5 isn't swallowed.
        approx(
            cost_of("claude-opus-5.5", &usage(1_000_000, 0, 0, 0, 0), None),
            4.0,
        );
        approx(
            cost_of("claude-opus-5", &usage(1_000_000, 0, 0, 0, 0), None),
            5.0,
        );
    }

    #[test]
    fn fable_rates() {
        // Fable 5 is $10 / $50 per 1M.
        approx(
            cost_of("claude-fable-5", &usage(1_000_000, 1_000_000, 0, 0, 0), None),
            60.0,
        );
        // Cache: read 0.1× ($1), 5m write 1.25× ($12.50), 1h write 2× ($20).
        approx(
            cost_of("claude-fable-5", &usage(0, 0, 1_000_000, 0, 0), None),
            1.0,
        );
        approx(
            cost_of("claude-fable-5", &usage(0, 0, 0, 1_000_000, 0), None),
            12.50,
        );
        approx(
            cost_of("claude-fable-5", &usage(0, 0, 0, 1_000_000, 1_000_000), None),
            20.0,
        );
        // No extended-context premium — flat rate above 200k.
        approx(
            cost_of("claude-fable-5", &usage(300_000, 0, 0, 0, 0), None),
            3.0,
        );
    }

    #[test]
    fn fable_5_1_rates() {
        // Same $10 / $50 per 1M as Fable 5.
        approx(
            cost_of("claude-fable-5-1", &usage(1_000_000, 1_000_000, 0, 0, 0), None),
            60.0,
        );
        // Cache reads are the one difference: $0.25 per 1M (0.025×), a quarter
        // of Fable 5's $1.00.
        approx(
            cost_of("claude-fable-5-1", &usage(0, 0, 1_000_000, 0, 0), None),
            0.25,
        );
        // Cache writes are unchanged: 5m $12.50, 1h $20.
        approx(
            cost_of("claude-fable-5-1", &usage(0, 0, 0, 1_000_000, 0), None),
            12.50,
        );
        approx(
            cost_of("claude-fable-5-1", &usage(0, 0, 0, 1_000_000, 1_000_000), None),
            20.0,
        );
        // Still flat above 200k — no extended-context premium.
        approx(
            cost_of("claude-fable-5-1", &usage(300_000, 0, 0, 0, 0), None),
            3.0,
        );
        // Plain Fable 5 must not be swallowed by the 5.1 match.
        approx(
            cost_of("claude-fable-5", &usage(0, 0, 1_000_000, 0, 0), None),
            1.0,
        );
        // A dotted slug resolves the same as the dashed one.
        approx(
            cost_of("claude-fable-5.1", &usage(0, 0, 1_000_000, 0, 0), None),
            0.25,
        );
    }

    #[test]
    fn mythos_bills_at_the_fable_tier() {
        // Mythos is the Fable tier under another name — it must not fall
        // through to the Sonnet default ($3 / $15), which would under-report
        // it by more than 3×.
        approx(
            cost_of("claude-mythos-5-1", &usage(1_000_000, 1_000_000, 0, 0, 0), None),
            60.0,
        );
        approx(
            cost_of("claude-mythos-5", &usage(1_000_000, 1_000_000, 0, 0, 0), None),
            60.0,
        );
        approx(
            cost_of("claude-mythos-preview", &usage(1_000_000, 0, 0, 0, 0), None),
            10.0,
        );
        // Mythos 5.1 shares Fable 5.1's $0.25 cache read; Mythos 5 keeps $1.00.
        approx(
            cost_of("claude-mythos-5-1", &usage(0, 0, 1_000_000, 0, 0), None),
            0.25,
        );
        approx(
            cost_of("claude-mythos-5.1", &usage(0, 0, 1_000_000, 0, 0), None),
            0.25,
        );
        approx(
            cost_of("claude-mythos-5", &usage(0, 0, 1_000_000, 0, 0), None),
            1.0,
        );
    }

    #[test]
    fn cache_read_savings_only_where_discounted() {
        // Fable 5.1: $1.00 - $0.25 = $0.75 saved per 1M cached tokens.
        approx(cache_read_savings_usd("claude-fable-5-1", 1_000_000), 0.75);
        approx(cache_read_savings_usd("claude-fable-5-1", 0), 0.0);
        // Mythos 5.1 matches Fable 5.1.
        approx(cache_read_savings_usd("claude-mythos-5-1", 1_000_000), 0.75);
        // Opus 5.5: $0.40 - $0.20 = $0.20 saved per 1M cached tokens.
        approx(cache_read_savings_usd("claude-opus-5-5", 1_000_000), 0.20);
        // Everything else prices cache reads at the standard 0.1×, so there
        // is nothing to report.
        approx(cache_read_savings_usd("claude-fable-5", 1_000_000), 0.0);
        approx(cache_read_savings_usd("claude-mythos-5", 1_000_000), 0.0);
        approx(cache_read_savings_usd("claude-sonnet-5-5", 1_000_000), 0.0);
        approx(cache_read_savings_usd("claude-haiku-5-5", 1_000_000), 0.0);
        approx(cache_read_savings_usd("claude-opus-5", 1_000_000), 0.0);
        approx(cache_read_savings_usd("claude-sonnet-5", 1_000_000), 0.0);
        approx(cache_read_savings_usd("unknown-model", 1_000_000), 0.0);
    }

    #[test]
    fn opus_legacy_rates() {
        // 4.1 and earlier keep $15 / $75.
        approx(
            cost_of("claude-opus-4-1", &usage(1_000_000, 1_000_000, 0, 0, 0), None),
            90.0,
        );
    }

    #[test]
    fn no_extended_context_premium_on_opus_4() {
        // Claude 4.6+ bills its full 1M context at standard rates, so Opus
        // 4.6–4.8 stay at $5/MTok above 200k.
        for model in ["claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8"] {
            approx(cost_of(model, &usage(200_001, 0, 0, 0, 0), None), 200_001.0 * 5.0 / 1_000_000.0);
        }
        // Cache reads + writes don't tip it into a premium either:
        //   1M out * 25 + 150k read * 0.5 + 60k 5m-write * 6.25, all /1M = 25.45.
        approx(
            cost_of("claude-opus-4-8", &usage(0, 1_000_000, 150_000, 60_000, 0), None),
            25.45,
        );
        // Legacy Opus has no long-context tier, so no premium.
        approx(
            cost_of("claude-opus-4-1", &usage(250_000, 0, 0, 0, 0), None),
            3.75,
        );
    }

    #[test]
    fn cache_write_1h_vs_5m_split() {
        // Sonnet: 1M of 5m writes ($3.75) vs 1M of 1h writes ($6).
        approx(
            cost_of("claude-sonnet-4-6", &usage(0, 0, 0, 1_000_000, 0), None),
            3.75,
        );
        approx(
            cost_of("claude-sonnet-4-6", &usage(0, 0, 0, 1_000_000, 1_000_000), None),
            6.0,
        );
        // Half-and-half: 1M total, 400k of it 1h → 600k*3.75 + 400k*6, /1M.
        approx(
            cost_of("claude-sonnet-4-6", &usage(0, 0, 0, 1_000_000, 400_000), None),
            4.65,
        );
    }

    #[test]
    fn sonnet_5_is_two_and_ten_on_every_date() {
        // $2 / $10: 100k in + 100k out = $0.20 + $1.00 = $1.20 — before, at,
        // and after the cancelled 2026-09-01 increase, and with no date.
        for ts in [Some(JULY_TS), Some(SEPT_TS), None] {
            approx(
                cost_of("claude-sonnet-5", &usage(100_000, 100_000, 0, 0, 0), ts),
                1.20,
            );
        }
        // Cache rates: read $0.20, 5m write $2.50, 1h write $4.00 per 1M.
        approx(
            cost_of("claude-sonnet-5", &usage(0, 0, 1_000_000, 0, 0), None),
            0.20,
        );
        approx(
            cost_of("claude-sonnet-5", &usage(0, 0, 0, 1_000_000, 0), None),
            2.50,
        );
        approx(
            cost_of("claude-sonnet-5", &usage(0, 0, 0, 1_000_000, 1_000_000), None),
            4.0,
        );
        // Sonnet 4.6 stays at the $3 / $15 standard tier.
        approx(
            cost_of("claude-sonnet-4-6", &usage(100_000, 100_000, 0, 0, 0), Some(JULY_TS)),
            1.80,
        );
    }

    #[test]
    fn sonnet_5_5_rates() {
        // Same $2 / $10 as Sonnet 5, flat across its 1M context.
        approx(
            cost_of("claude-sonnet-5-5", &usage(1_000_000, 1_000_000, 0, 0, 0), None),
            12.0,
        );
        approx(
            cost_of("claude-sonnet-5-5", &usage(300_000, 0, 0, 0, 0), None),
            0.60,
        );
        // Cache read at the conservative $0.20 — see SONNET_5.
        approx(
            cost_of("claude-sonnet-5-5", &usage(0, 0, 1_000_000, 0, 0), None),
            0.20,
        );
    }

    #[test]
    fn haiku_tier_split() {
        // Haiku 4.5 is $1 / $5; 3.5 is the legacy $0.80 / $4.
        approx(
            cost_of("claude-haiku-4-5", &usage(1_000_000, 1_000_000, 0, 0, 0), None),
            6.0,
        );
        approx(
            cost_of(
                "claude-3-5-haiku-20241022",
                &usage(1_000_000, 1_000_000, 0, 0, 0),
                None,
            ),
            4.80,
        );
    }

    #[test]
    fn haiku_5_5_short_prompt_rates() {
        // ≤100k prompt: $0.10 / $0.50. 100k in + 1M out = $0.01 + $0.50.
        approx(
            cost_of("claude-haiku-5-5", &usage(100_000, 1_000_000, 0, 0, 0), None),
            0.51,
        );
        // Cache: read $0.01, 5m write $0.125, 1h write $0.20 per 1M — scaled to
        // 100k-token prompts so they stay on the short tier.
        approx(
            cost_of("claude-haiku-5-5", &usage(0, 0, 100_000, 0, 0), None),
            0.001,
        );
        approx(
            cost_of("claude-haiku-5-5", &usage(0, 0, 0, 100_000, 0), None),
            0.0125,
        );
        approx(
            cost_of("claude-haiku-5-5", &usage(0, 0, 0, 100_000, 100_000), None),
            0.02,
        );
        // Dotted slug resolves the same; Haiku 4.5 isn't swallowed.
        approx(
            cost_of("claude-haiku-5.5", &usage(100_000, 0, 0, 0, 0), None),
            0.01,
        );
        approx(
            cost_of("claude-haiku-4-5", &usage(100_000, 0, 0, 0, 0), None),
            0.10,
        );
    }

    #[test]
    fn haiku_5_5_long_prompt_tier() {
        // One token over 100k moves the whole turn to $0.50 / $2.50.
        approx(
            cost_of("claude-haiku-5-5", &usage(100_001, 1_000_000, 0, 0, 0), None),
            100_001.0 * 0.50 / 1_000_000.0 + 2.50,
        );
        // The threshold counts cache reads + writes, not just fresh input:
        //   prompt = 1k in + 80k read + 30k 1h-write = 111k > 100k →
        //   1k * 0.50 + 80k * 0.05 + 30k * 1.0 + 10k out * 2.50, all /1M.
        approx(
            cost_of("claude-haiku-5-5", &usage(1_000, 10_000, 80_000, 30_000, 30_000), None),
            (1_000.0 * 0.50 + 80_000.0 * 0.05 + 30_000.0 * 1.0 + 10_000.0 * 2.50) / 1_000_000.0,
        );
        // Long-tier cache rates per 1M: read $0.05, 5m write $0.625, 1h $1.
        approx(
            cost_of("claude-haiku-5-5", &usage(0, 0, 1_000_000, 0, 0), None),
            0.05,
        );
        approx(
            cost_of("claude-haiku-5-5", &usage(0, 0, 0, 1_000_000, 0), None),
            0.625,
        );
        approx(
            cost_of("claude-haiku-5-5", &usage(0, 0, 0, 1_000_000, 1_000_000), None),
            1.0,
        );
    }

    #[test]
    fn openai_model_tiers() {
        // For Codex, usage.input is uncached, usage.cache_read is the cached portion.
        // GPT-5.5: $5 in / $0.50 cached / $30 out.
        approx(
            openai_cost_of("gpt-5.5", &usage(1_000_000, 1_000_000, 1_000_000, 0, 0), None),
            35.50,
        );
        // GPT-5.4: $2.50 / $0.25 / $15.
        approx(
            openai_cost_of("gpt-5.4", &usage(1_000_000, 1_000_000, 0, 0, 0), None),
            17.50,
        );
        // GPT-5.4 mini must beat the plain "mini" branch: $0.75 / $0.075 / $4.50.
        approx(
            openai_cost_of("gpt-5.4-mini", &usage(1_000_000, 1_000_000, 0, 0, 0), None),
            5.25,
        );
        // GPT-5.4 nano ($0.20 / $0.02 / $1.25) is 4× the legacy gpt-5-nano
        // tier — it must not fall through to the generic "nano" branch.
        approx(
            openai_cost_of("gpt-5.4-nano", &usage(1_000_000, 1_000_000, 1_000_000, 0, 0), None),
            1.47,
        );
        // Legacy tiers still resolve.
        approx(
            openai_cost_of("gpt-5-codex", &usage(1_000_000, 0, 0, 0, 0), None),
            1.25,
        );
        approx(
            openai_cost_of("gpt-5-mini", &usage(1_000_000, 0, 0, 0, 0), None),
            0.25,
        );
        approx(
            openai_cost_of("gpt-5-nano", &usage(1_000_000, 0, 0, 0, 0), None),
            0.05,
        );
    }

    #[test]
    fn gpt_5_6_family_tiers() {
        // Sol: $5 / $0.50 / $30.
        approx(
            openai_cost_of("gpt-5.6-sol", &usage(1_000_000, 1_000_000, 1_000_000, 0, 0), None),
            35.50,
        );
        // The bare `gpt-5.6` alias resolves to Sol, not to a cheaper tier.
        approx(
            openai_cost_of("gpt-5.6", &usage(1_000_000, 0, 0, 0, 0), None),
            5.0,
        );
        // Terra at current rates: $2 / $0.20 / $12.
        approx(
            openai_cost_of("gpt-5.6-terra", &usage(1_000_000, 1_000_000, 1_000_000, 0, 0), None),
            14.20,
        );
        // Luna at current rates: $0.20 / $0.02 / $1.20.
        approx(
            openai_cost_of("gpt-5.6-luna", &usage(1_000_000, 1_000_000, 1_000_000, 0, 0), None),
            1.42,
        );
        // Hyphenated slugs resolve the same as dotted ones.
        approx(
            openai_cost_of("gpt-5-6-luna", &usage(1_000_000, 0, 0, 0, 0), None),
            0.20,
        );
    }

    #[test]
    fn gpt_5_6_price_cut_window() {
        // A day before the 2026-07-30 cut, Terra was $2.50 / $15 and Luna
        // $1 / $6.
        let before = GPT_5_6_PRICE_CUT_MS - 86_400_000;
        approx(
            openai_cost_of("gpt-5.6-terra", &usage(1_000_000, 1_000_000, 0, 0, 0), Some(before)),
            17.50,
        );
        approx(
            openai_cost_of("gpt-5.6-luna", &usage(1_000_000, 1_000_000, 0, 0, 0), Some(before)),
            7.0,
        );
        // Cached input moved too: $0.25 → $0.20 (Terra), $0.10 → $0.02 (Luna).
        approx(
            openai_cost_of("gpt-5.6-terra", &usage(0, 0, 1_000_000, 0, 0), Some(before)),
            0.25,
        );
        approx(
            openai_cost_of("gpt-5.6-luna", &usage(0, 0, 1_000_000, 0, 0), Some(before)),
            0.10,
        );
        // The boundary is inclusive on the cheap side: the cut instant itself
        // bills at the new rates.
        approx(
            openai_cost_of(
                "gpt-5.6-terra",
                &usage(1_000_000, 1_000_000, 0, 0, 0),
                Some(GPT_5_6_PRICE_CUT_MS),
            ),
            14.0,
        );
        // Sol was untouched by the cut.
        approx(
            openai_cost_of("gpt-5.6-sol", &usage(1_000_000, 0, 0, 0, 0), Some(before)),
            5.0,
        );
    }

    #[test]
    fn openai_codex_and_pro_tiers() {
        // gpt-5.3-codex / gpt-5.2-codex: $1.75 / $0.175 / $14.
        approx(
            openai_cost_of("gpt-5.3-codex", &usage(1_000_000, 1_000_000, 1_000_000, 0, 0), None),
            15.925,
        );
        approx(
            openai_cost_of("gpt-5.2-codex", &usage(1_000_000, 0, 0, 0, 0), None),
            1.75,
        );
        // codex-max is its own tier and must not be read as a 5.1 nano/mini.
        approx(
            openai_cost_of("gpt-5.1-codex-max", &usage(1_000_000, 1_000_000, 0, 0, 0), None),
            11.25,
        );
        // Pro tiers: $30 / $180, with no cached-input discount published.
        approx(
            openai_cost_of("gpt-5.5-pro", &usage(1_000_000, 1_000_000, 0, 0, 0), None),
            210.0,
        );
        approx(
            openai_cost_of("gpt-5.4-pro", &usage(0, 0, 1_000_000, 0, 0), None),
            30.0,
        );
    }
}
