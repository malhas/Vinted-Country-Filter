# Keyword Boolean Filter Design

Date: 2026-06-26
Status: Approved for planning

## Summary

Add client-side keyword include/exclude filtering to the Vinted Country & City Filter userscript. The feature filters the Vinted items already loaded on the page and combines with the existing country filter. It does not try to modify Vinted's server-side search results.

The script will reuse the existing item details API request to collect searchable text from item details, including title and description, then cache that text alongside country and city data.

## Goals

- Let users enter words or phrases that an item must include.
- Let users enter words or phrases that an item must exclude.
- Support a simple `AND | OR` mode for include rules and another `AND | OR` mode for exclude rules.
- Match against visible card text plus fetched item detail fields, especially title and description.
- Reuse the existing Vinted item details fetch and cache to avoid a second API pass.
- Save keyword rules in presets together with country selections.

## Non-Goals

- Do not implement full boolean expression parsing such as `(pokemon OR zelda) AND switch NOT case`.
- Do not change Vinted URL parameters or server-side search behavior.
- Do not add automation that messages, buys, favorites, follows, or otherwise mutates the Vinted account.
- Do not require new third-party services or libraries.

## User Interface

Add a `Keyword Filters` section in the Settings tab, below presets and above country checkboxes.

The section contains:

- `Include words` textarea.
- Include mode segmented control: `AND | OR`.
- `Exclude words` textarea.
- Exclude mode segmented control: `AND | OR`.
- A small result summary can reuse the existing shown/total counters instead of adding another stats block.

Inputs accept comma-separated or line-separated entries. Each entry is trimmed. Empty entries are ignored. Multi-word entries are treated as phrases and matched by normalized substring.

## Matching Semantics

Build a normalized searchable string per item from:

- Visible item card text.
- Fetched item title.
- Fetched item description.
- Other clean item detail fields if they are already available and useful, such as brand or catalog title.

Normalization should lowercase text, collapse whitespace, and remove diacritics so `pokemon`, `pokémon`, and `Pokémon` match consistently.

Include rules:

- If there are no include entries, the include rule passes.
- `AND`: every include entry must appear in the item searchable text.
- `OR`: at least one include entry must appear in the item searchable text.

Exclude rules:

- If there are no exclude entries, the exclude rule passes.
- `OR`: the item is hidden when any exclude entry appears.
- `AND`: the item is hidden only when every exclude entry appears.

Final visibility:

An item is shown at full opacity only when it matches the existing country rule and the keyword rule. Non-matching items use the existing faded/grayscale treatment.

## Data Flow

1. `scanItems()` creates the item record with visible card text when an item first appears.
2. `processQueue()` fetches item details as it already does for seller country/city.
3. Detail parsing stores country, city, seller, title, description, and `searchableText` on the item record.
4. `setCachedItem()` stores searchable fields with the existing cache entry.
5. `getCachedItem()` remains backward compatible with old cache entries that do not have searchable text.
6. If keyword filters are active and an old cache entry lacks detail searchable text, the item should be refetched once so description-based matching is accurate.
7. `applyFilter()` evaluates both country and keyword rules whenever settings change or new item data arrives.

Items should not be permanently hidden by keyword rules until their detail request has completed or the script has confirmed the item cannot be fetched. This avoids false negatives from filtering only the visible card text while descriptions are still pending.

## Persistence

Use `sessionStorage` for active keyword settings, consistent with the current country filter behavior:

- `vinted_include_keywords`
- `vinted_include_keyword_mode`
- `vinted_exclude_keywords`
- `vinted_exclude_keyword_mode`

Preset JSON should expand from:

```json
{ "countries": ["portugal"] }
```

to:

```json
{
  "countries": ["portugal"],
  "includeKeywords": ["pokemon", "sword"],
  "includeKeywordMode": "AND",
  "excludeKeywords": ["case", "box"],
  "excludeKeywordMode": "OR"
}
```

Loading older presets should default missing keyword fields to empty lists and `AND` for include, `OR` for exclude.

## Error Handling

- If an item details request returns `403` or `429`, keep the current access-block and rate-limit behavior.
- If a single item cannot be fetched and the API is otherwise healthy, mark it unavailable as currently designed. Keyword matching for that item should fall back to visible card text only.
- Invalid or empty keyword input should not show errors; it should behave as no keyword filter for that side.

## Testing

Add focused unit tests for:

- Keyword parsing from comma-separated and line-separated input.
- Accent-insensitive and case-insensitive matching.
- Include `AND` and `OR` behavior.
- Exclude `AND` and `OR` behavior.
- Country and keyword rules combining correctly.
- Cached item detail text being used for keyword filtering.
- Old cache entries without searchable text triggering a refetch when keyword filters are active.
- Presets saving and loading keyword rules while remaining backward compatible with old presets.

## Open Decisions

No open product decisions remain for the first implementation. The first version will use the simple per-list `AND | OR` controls and description-based matching through existing item detail fetches.
