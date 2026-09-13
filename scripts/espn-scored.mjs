// Which fixtures.json rows take their live state and final score from ESPN.
//
// nations.json (api-sports, league 145) is the live feed for exactly ONE
// competition — the Nations Championship — and the app merges its state onto
// rnc-* rows itself. Everything else the app lists has no other source:
// one-off tests, test series, and every other registered competition (the
// Pacific Nations Cup today; the Six Nations and the World Cup when they
// come). Those get their scores from ESPN's keyless core API in
// build-fixtures, and the match-day burst loops for them.
//
// Before 2026-09-13 only test/series rows were scored this way, so the PNC
// semi-final Japan v USA reached the app as a fixture but never as a result.
// The rule lives here so build-fixtures, the burst and the refresh-due check
// cannot drift apart on it.
export function scoredByEspn(comp) {
  const kind = comp?.kind;
  if (kind === "test" || kind === "series") return true;
  if (kind === "competition") return !String(comp.key ?? "").startsWith("rnc-");
  return false;
}

// Rows whose kickoff should open the fixtures burst: the ESPN-scored ones
// plus tour games, whose scores come from the api-sports probe but ride the
// same rebuild.
export const liveTracked = (comp) => comp?.kind === "tour" || scoredByEspn(comp);
