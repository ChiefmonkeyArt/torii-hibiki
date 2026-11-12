# ADR-0005: News link quality — read shared links in the background, show articles only, lead with one story

- **Status:** Accepted (2026-11-12; shipped in v0.2.12; amended in v0.2.13 and v0.2.14)
- **Applies to:** the News section, the "In the news" rows on Today, the "Shared videos" grid on Watch, and the node's link preview proxy.
- **Relates to:** ADR-0001 (personalised discovery; section 9 product focus and TL;DR summaries), ADR-0004 (lean event store).

## Context

News was built from every link in notes, reposts and picture posts (kinds 1, 6 and 20) shared by the owner, their follows and the 2-hop circle in the last 72 hours. Links were grouped by exact address and ranked like notes. The node read a page only when a reader opened its card.

On the development copy this gave 60 "stories". Many were not news: YouTube videos, GitHub repositories, shops, app stores, sign-up and donation pages, link shorteners, other Nostr clients, and the same article under its AMP, mobile and tracking-tagged addresses. The cards looked alike, so a reader could not see at a glance what a story was, where it came from or who shared it.

## Decision

1. **The node reads newly shared links in the background.** This changes established behaviour: before, a page was fetched only when its card was viewed. Each sync (and 90 seconds after start) the feed passes the circle's new links to `service/src/links.mjs`. It reads them through the existing link proxy, so the same rules apply: `safefetch` (https only, public addresses, size and time caps) and the same cache. At most 2 requests run at once and 600 wait in the queue. Results are kept in memory (4,000 links); a failed link is retried after 6 hours. Links from known code, social, shop, audio and campaign sites are classified by host and never fetched.
2. **Classification.** Each link becomes `article`, `video`, `code`, `social`, `shop`, `audio`, `page`, `short` or `unknown`:
   - by host first (lists in `links.mjs`);
   - then by the page: product markup or a price is `shop`; book, app, event and similar JSON-LD types, store and help sub-domains, and paths such as `/shop`, `/signup` or `/donate` are `page`; `og:type` article, article JSON-LD or a publish date is `article`; video markup is `video`;
   - a page published more than 30 days ago is `page`;
   - otherwise a page is an article only if its address looks like a headline, it reads for 2 minutes or more and a TL;DR was found.
   News shows articles. Watch shows video links under "Shared videos". Code links go to a small "Dev" strip beside News.
3. **One story per article.** Addresses are merged by a story key: `www.`, `m.`, `amp.` and `mobile.` hosts, `/amp` paths, AMP and tracking query parameters and trailing slashes are removed. A page's canonical address is trusted only when it is on the same site, so a page cannot claim another site's story.
4. **Ranking.** A story's new `discuss` signal is the sum of its sharers: 1 for a comment of 20 characters or more, 0.35 for a bare share or repost, halved for people the owner does not follow. It is labelled "Shared in your circle". At most 2 stories from one site can sit above the rest (`rerank` with `by: 'site'`).
5. **Presentation.** News opens with one lead card (the first of the top three with a picture), then a tight list. Each row shows the site icon and name, read time, headline, a one-line TL;DR, "N in your circle · M more" with avatars, and the best comment from the circle. Links not read yet are shown only when their address reads like a headline, and are filled in when read.
6. **Previews are cached raw.** Image and icon addresses are signed when a preview is served, not when it is cached, so cached previews stay valid if the node's secret changes. YouTube links use YouTube's oEmbed answer (title, channel, thumbnail), because YouTube serves the node a "browser deprecated" page.

## Consequences

- News on the development copy went from 60 mixed links to about 36 real stories.
- The node makes more outbound requests: one per new link in the circle, not one per viewed card. They are rate limited, cached and go only to the sites the circle shared; readers' browsers still talk only to the node.
- A few real articles on sites without article markup may be missed; a few landing pages will get through. The host lists are the place to fix both.
- No new data is stored on disk beyond the existing link cache.

## Amendment (v0.2.13, 2026-11-12)

The "Later" items shipped:

- **One event, many outlets.** Titled article stories from different domains fold into the most-shared one when their headlines share at least 3 meaningful words covering half or more of the shorter headline (`headWords`, `sameEvent` in `feed.mjs`). The card shows "N outlets"; the panel lists "Also covered by". Sharers, comments and topics merge.
- **Ranking caps by domain**, not display name (`rerank` with `by: 'domain'`), so two sites with the same name are capped apart.
- **Owner settings:** "Follows only", "Hide <domain>" and "Trust <domain>". A trusted site adds a fixed +0.5 rank part labelled "A site you trust".
- **"+N more"** under the best comment opens all comments; up to 8 are kept per story.
- **Sort and topic chips:** Top, Latest, Most discussed, and hashtags shared by two or more stories (generic tags such as "uncategorized" are dropped).
- **Read state and "N new since your last visit".** These and the settings are kept by the shell in the browser's local storage only, checked and bounded on save (100 sites per list, 300 read ids). Nothing is sent to the node.
- **HTML entities:** Latin-1 names (for example `&ouml;`) and double-encoded names are decoded in titles, also for previews already in the cache.

## Amendment (v0.2.14, 2026-11-12)

- **Cart buttons mean a shop.** Some shop pages say `og:type` article (a WordPress default). A page with 3 or more "Add to cart", "Add to basket" or "Add to bag" buttons, or whose summary contains the phrase, is classified `shop` before any article rule. The summary check covers previews already cached.
- **Titles are tidied when served** (`cleanTitle` in `proxy.mjs`), so cached previews are covered too and nothing is re-read. Stray separators at either end go. A trailing part (after " | ", " - ", " – ", " — ", " · " or "::") is dropped when it is the site name or domain, or the site name plus a short word ("CEASE report"). A leading part is dropped only when it is exactly the site name. A title that is only the site name is kept.
