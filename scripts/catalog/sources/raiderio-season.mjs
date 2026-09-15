// Raider.IO supplies seasonal membership Blizzard's journal lacks; public API contract at https://raider.io/api.

function active(entry, region, now) {
  const start = Date.parse(entry?.starts?.[region]);
  const end = Date.parse(entry?.ends?.[region]);
  return Number.isFinite(start) && Number.isFinite(end) && start <= now && now < end;
}

export function selectSeason(mythic, raiding, seasonId, region, now = Date.now()) {
  const matches = mythic.seasons?.filter((s) => s.is_main_season === true
    && s.blizzard_season_id === seasonId && active(s, region, now));
  if (matches?.length !== 1 || !Array.isArray(matches[0].dungeons) || !matches[0].dungeons.length) {
    throw new Error('Raider.IO has no unique active Mythic+ season matching Blizzard');
  }
  if (!Array.isArray(raiding.raids)) throw new Error('Invalid Raider.IO raid data');
  const season = matches[0];
  return {
    dungeons: season.dungeons,
    raids: raiding.raids.filter((r) => active(r, region, now)),
    // Never retain a snapshot through a known season/raid rollover.
    expiresAt: new Date(Math.min(Date.parse(season.ends[region]),
      ...raiding.raids.flatMap((r) => [Date.parse(r.starts?.[region]), Date.parse(r.ends?.[region])])
        .filter((t) => Number.isFinite(t) && t > now))).toISOString(),
  };
}

export async function fetchSeason(config, seasonId, fetchImpl = fetch, now = Date.now()) {
  const get = async (kind) => {
    const url = `https://raider.io/api/v1/${kind}/static-data?expansion_id=${config.raiderioExpansionId ?? 11}`;
    // Never send Blizzard's bearer token to Raider.IO.
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Raider.IO ${kind}: HTTP ${response.status}`);
    return response.json();
  };
  const mythic = await get('mythic-plus');
  const raiding = await get('raiding');
  return selectSeason(mythic, raiding, seasonId, config.region, now);
}

/** Match English API names; IDs belong to different namespaces in the two APIs. */
export function journalMembers(members, journal) {
  const normalize = (name) => typeof name === 'string'
    ? name.normalize('NFKC').replace(/[’‘]/g, "'").trim().toLowerCase() : '';
  return members.map((member) => {
    const name = normalize(member.name);
    // Match English API names; IDs belong to different namespaces in two APIs.
    const matches = journal.filter((entry) => name && normalize(entry.name) === name);
    if (matches.length !== 1 || !Number.isInteger(matches[0].id) || matches[0].id <= 0) {
      throw new Error(`Cannot uniquely match seasonal activity ${member.name} to Blizzard's journal`);
    }
    return matches[0];
  });
}
