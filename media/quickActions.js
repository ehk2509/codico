// Pure ordering/filtering logic for the Quick Actions palette (media/chat.js
// renders it). Kept free of DOM and vscode APIs so it can be unit tested.
(function () {
  'use strict';

  /** Most rows rendered at once: the palette also searches 200+ models. */
  var MAX_ROWS = 50;
  /** Palette section order. Groups outside this list keep their discovery order, after these. */
  var GROUP_ORDER = ['Commands', 'Modes', 'Models', 'Threads', 'Preferences'];

  /**
   * How well one item matches a lower-cased query. Lower is better; -1 is no match.
   * Exact label beats label prefix, which beats a mid-label hit (earlier wins),
   * then a hint hit, then a group hit — so "/compact" finds the command, not its group.
   */
  function scoreItem(item, q) {
    var label = String(item && item.label || '').toLowerCase();
    var hint = String(item && item.hint || '').toLowerCase();
    var group = String(item && item.group || '').toLowerCase();
    if (label === q) { return 0; }
    if (label.indexOf(q) === 0) { return 1; }
    var at = label.indexOf(q);
    if (at !== -1) { return 2 + Math.min(at, 99) / 100; }
    if (hint.indexOf(q) !== -1) { return 3; }
    if (group.indexOf(q) !== -1) { return 4; }
    return -1;
  }

  /** Matching items, best first. An empty query returns every item in its given order. */
  function filter(items, query) {
    var list = items || [];
    var q = String(query === undefined || query === null ? '' : query).trim().toLowerCase();
    if (!q) { return list.slice(); }
    var scored = [];
    for (var i = 0; i < list.length; i++) {
      var score = scoreItem(list[i], q);
      if (score !== -1) { scored.push({ item: list[i], score: score, index: i }); }
    }
    scored.sort(function (a, b) { return a.score - b.score || a.index - b.index; });
    return scored.map(function (entry) { return entry.item; });
  }

  /** The first `max` items (MAX_ROWS by default), as a copy. */
  function limit(items, max) {
    var list = items || [];
    var n = typeof max === 'number' && max > 0 ? max : MAX_ROWS;
    return list.length > n ? list.slice(0, n) : list.slice();
  }

  /** `[{ group, items }]` in GROUP_ORDER, with unknown groups last in discovery order. */
  function groupBy(items) {
    var list = items || [];
    var buckets = {};
    var order = [];
    for (var i = 0; i < list.length; i++) {
      var group = String(list[i] && list[i].group || 'Other');
      if (!buckets[group]) { buckets[group] = []; order.push(group); }
      buckets[group].push(list[i]);
    }
    order.sort(function (a, b) {
      var ia = GROUP_ORDER.indexOf(a);
      var ib = GROUP_ORDER.indexOf(b);
      if (ia === -1 && ib === -1) { return 0; }
      if (ia === -1) { return 1; }
      if (ib === -1) { return -1; }
      return ia - ib;
    });
    return order.map(function (group) { return { group: group, items: buckets[group] }; });
  }

  var api = { MAX_ROWS: MAX_ROWS, GROUP_ORDER: GROUP_ORDER, filter: filter, limit: limit, groupBy: groupBy };
  if (typeof window !== 'undefined') { window.CodicoQuickActions = api; }
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})();
