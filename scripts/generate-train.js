const fs = require("fs");
const crypto = require("crypto");

const API = "https://www.lastwar.farm/api/v1";
const MIN_DONATIONS = 30000;
const API_KEY = process.env.FARMOPS_API_KEY;

if (!API_KEY) {
  console.error("ERROR: FARMOPS_API_KEY is missing.");
  process.exit(1);
}

async function farmOps(path) {
  const response = await fetch(API + path, {
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: "application/json"
    }
  });

  let body = {};

  try {
    body = await response.json();
  } catch {
    // handled below
  }

  if (!response.ok) {
    console.error(
      "FarmOps API error:",
      response.status,
      body?.error?.code || "",
      body?.error?.message || ""
    );
    process.exit(1);
  }

  // Most FarmOps endpoints wrap results in data.
  // /alliance/export may contain a large object.
  return body.data ?? body;
}

function toBigInt(value) {
  try {
    return BigInt(value || "0");
  } catch {
    return 0n;
  }
}

function normalize(value, maximum) {
  if (maximum <= 0n) return 0;
  return Number((value * 10000n) / maximum) / 100;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/*
 * Recursively look through the FarmOps export for keys that
 * appear to contain VS / duel information.
 *
 * We intentionally do NOT print the API key.
 */
function findVsStructures(value, path = "export", results = [], depth = 0) {
  if (depth > 8 || value === null || value === undefined) {
    return results;
  }

  if (Array.isArray(value)) {
    if (value.length) {
      const sample = value[0];

      if (sample && typeof sample === "object") {
        const keys = Object.keys(sample);

        const interesting = keys.some(key =>
          /duel|vs|score|weekly|week/i.test(key)
        );

        if (interesting) {
          results.push({
            path,
            type: "array",
            count: value.length,
            sample
          });
        }
      }
    }

    for (let i = 0; i < Math.min(value.length, 3); i++) {
      findVsStructures(
        value[i],
        `${path}[${i}]`,
        results,
        depth + 1
      );
    }

    return results;
  }

  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;

      if (/duel|vs|score|weekly|week/i.test(key)) {
        results.push({
          path: childPath,
          type: Array.isArray(child)
            ? "array"
            : typeof child,
          count: Array.isArray(child)
            ? child.length
            : undefined,
          sample: Array.isArray(child)
            ? child[0]
            : child
        });
      }

      findVsStructures(
        child,
        childPath,
        results,
        depth + 1
      );
    }
  }

  return results;
}

async function generate() {
  console.log("Connecting to FarmOps...");

  const [
    alliance,
    members,
    dailyDuels,
    donations,
    fullExport,
    powerRows,
    killRows,
    thpRows
  ] = await Promise.all([
    farmOps("/alliance"),
    farmOps("/alliance/members"),
    farmOps("/alliance/members/duels"),
    farmOps("/alliance/members/donations"),
    farmOps("/alliance/export"),
    farmOps("/alliance/members/power"),
    farmOps("/alliance/members/kills"),
    farmOps("/alliance/members/thp")
  ]);

  // Manual exclusions override FarmOps when a departed member is still reported ACTIVE.
  const MANUAL_EXCLUSIONS = new Set(["Sadaji"]);

  const activeMembers = members.filter(
    member => member.status === "ACTIVE" && !MANUAL_EXCLUSIONS.has(member.name)
  );

  const activeIds = new Set(
    activeMembers.map(member => member.id)
  );

  console.log(`Active members: ${activeMembers.length}`);

  // Members-only mode: refresh roster/dashboard without changing the locked Train schedule.
  const membersOnly = process.argv.includes("--members-only");

  // Publish only the minimum public roster data needed by the Members login page.
  // Never publish the FarmOps API key or full FarmOps member records.
  fs.writeFileSync(
    "data/members.json",
    JSON.stringify({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      alliance: alliance.name || "FEAR",
      members: activeMembers.map(member => ({ name: member.name }))
    }, null, 2) + "\n"
  );

  // --------------------------------------------------
  // MEMBER DASHBOARD METRICS
  // FarmOps metric endpoints return historical rows. Keep the newest
  // row for each member and publish only the fields used by the site.
  // --------------------------------------------------

  function latestMetric(rows, valueKeys) {
    const map = new Map();

    for (const row of Array.isArray(rows) ? rows : []) {
      const memberId = row.memberId || row.member_id || row.id;
      if (!memberId) continue;

      const stamp = String(
        row.recordedAt || row.recorded_at || row.scoredOn ||
        row.scored_on || row.createdAt || row.created_at ||
        row.date || row.weekStart || ""
      );

      let value = null;
      for (const key of valueKeys) {
        if (row[key] !== undefined && row[key] !== null) {
          value = row[key];
          break;
        }
      }
      if (value === null) continue;

      const previous = map.get(memberId);
      if (!previous || stamp >= previous.stamp) {
        map.set(memberId, { value: String(value), stamp });
      }
    }

    return map;
  }

  const powerMap = latestMetric(powerRows, ["power", "totalPower", "value"]);
  const killMap = latestMetric(killRows, ["kills", "killCount", "totalKills", "value"]);
  const thpMap = latestMetric(thpRows, ["thp", "totalHeroPower", "heroPower", "value"]);

  // VS details for the member dashboard: yesterday plus the current Monday-Sunday week.
  const now = new Date();
  const yesterdayDateObj = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  yesterdayDateObj.setUTCDate(yesterdayDateObj.getUTCDate() - 1);
  const yesterdayDate = yesterdayDateObj.toISOString().slice(0, 10);

  const currentDateObj = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayOfWeek = currentDateObj.getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const currentVsWeekStartObj = new Date(currentDateObj);
  currentVsWeekStartObj.setUTCDate(currentVsWeekStartObj.getUTCDate() - daysSinceMonday);
  const currentVsWeekStart = currentVsWeekStartObj.toISOString().slice(0, 10);
  const currentVsWeekEnd = addDays(currentVsWeekStart, 6);

  const yesterdayVsMap = new Map();
  const weeklyVsMap = new Map();

  for (const row of Array.isArray(dailyDuels) ? dailyDuels : []) {
    if (!activeIds.has(row.memberId)) continue;
    const scoredOn = String(row.scoredOn || row.scored_on || "").slice(0, 10);
    const score = toBigInt(row.score);

    if (scoredOn === yesterdayDate) {
      yesterdayVsMap.set(row.memberId, (yesterdayVsMap.get(row.memberId) || 0n) + score);
    }

    if (scoredOn >= currentVsWeekStart && scoredOn <= currentVsWeekEnd) {
      weeklyVsMap.set(row.memberId, (weeklyVsMap.get(row.memberId) || 0n) + score);
    }
  }

  const dashboardMembers = activeMembers.map(member => ({
    name: member.name,
    power: powerMap.get(member.id)?.value || null,
    thp: thpMap.get(member.id)?.value || null,
    kills: killMap.get(member.id)?.value || null,
    hq: member.hqLevel ?? member.hq ?? member.headquartersLevel ?? member.headquarters ?? null,
    yesterdayVs: (yesterdayVsMap.get(member.id) || 0n).toString(),
    weeklyVs: (weeklyVsMap.get(member.id) || 0n).toString()
  }));

  fs.writeFileSync(
    "data/member-dashboard.json",
    JSON.stringify({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      source: "FarmOps API",
      alliance: alliance.name || "FEAR",
      yesterday_date: yesterdayDate,
      vs_week_start: currentVsWeekStart,
      vs_week_end: currentVsWeekEnd,
      members: dashboardMembers
    }, null, 2) + "\n"
  );

  console.log(
    `Dashboard metrics: power=${powerMap.size}, thp=${thpMap.size}, kills=${killMap.size}, hq=${dashboardMembers.filter(member => member.hq !== null).length}, yesterdayVS=${yesterdayVsMap.size}, weeklyVS=${weeklyVsMap.size}`
  );

  if (membersOnly) {
    console.log("Members-only refresh complete; Train schedule unchanged.");
    return;
  }

  // --------------------------------------------------
  // FIND CURRENT WEEK FROM FARMOPS DONATION DATA
  // --------------------------------------------------

  const donationRows = donations.filter(
    row => activeIds.has(row.memberId)
  );

  if (!donationRows.length) {
    throw new Error(
      "FarmOps returned no weekly donation data for active members."
    );
  }

  const weekStart = donationRows
    .map(row => row.weekStart)
    .sort()
    .reverse()[0];

  const weekEnd = addDays(weekStart, 6);

  console.log(
    `FarmOps week: ${weekStart} through ${weekEnd}`
  );

  // --------------------------------------------------
  // DONATIONS
  // --------------------------------------------------

  const donationMap = new Map();

  for (const row of donationRows) {
    if (row.weekStart === weekStart) {
      donationMap.set(
        row.memberId,
        toBigInt(row.total)
      );
    }
  }

  // --------------------------------------------------
  // DAILY VS DATA
  // --------------------------------------------------

  const vsMap = new Map();

  for (const row of dailyDuels) {
    if (
      activeIds.has(row.memberId) &&
      row.scoredOn >= weekStart &&
      row.scoredOn <= weekEnd
    ) {
      const previous =
        vsMap.get(row.memberId) || 0n;

      vsMap.set(
        row.memberId,
        previous + toBigInt(row.score)
      );
    }
  }

  console.log(
    `Daily VS rows returned: ${dailyDuels.length}`
  );

  console.log(
    `Members with daily VS this week: ${vsMap.size}`
  );

  // --------------------------------------------------
  // IF DAILY VS IS EMPTY, INSPECT FULL FARMOPS EXPORT
  // --------------------------------------------------

  if (vsMap.size === 0) {
    console.log("");
    console.log(
      "WARNING: No daily VS records were returned."
    );

    console.log(
      "FarmOps web UI may be using weekly VS totals."
    );

    console.log("");
    console.log(
      "Inspecting /alliance/export for VS structures..."
    );

    const candidates =
      findVsStructures(fullExport);

    console.log("");
    console.log(
      "POSSIBLE VS / WEEKLY DATA STRUCTURES:"
    );

    if (!candidates.length) {
      console.log(
        "No obvious VS structures found in alliance export."
      );
    } else {
      /*
       * Limit output so GitHub Actions does not become
       * unreadable.
       */
      for (const candidate of candidates.slice(0, 30)) {
        console.log("");
        console.log("PATH:", candidate.path);
        console.log("TYPE:", candidate.type);

        if (candidate.count !== undefined) {
          console.log("COUNT:", candidate.count);
        }

        console.log(
          "SAMPLE:",
          JSON.stringify(
            candidate.sample,
            null,
            2
          )
        );
      }
    }

    /*
     * Save the structure names for inspection.
     * This file contains FarmOps alliance data, so don't
     * automatically publish it to a public website.
     */
    fs.writeFileSync(
      "data/farmops-vs-diagnostic.json",
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          weekStart,
          weekEnd,
          dailyDuelRows: dailyDuels.length,
          candidates
        },
        null,
        2
      ) + "\n"
    );

    throw new Error(
      "FarmOps returned no daily VS rows. " +
      "Weekly VS structure diagnostic created at " +
      "data/farmops-vs-diagnostic.json. " +
      "Review the PATH/SAMPLE output above."
    );
  }

  // --------------------------------------------------
  // HISTORY / OVERRIDES
  // --------------------------------------------------

  const history = JSON.parse(
    fs.readFileSync(
      "data/train-history.json",
      "utf8"
    )
  );

  const overrides = JSON.parse(
    fs.readFileSync(
      "data/train-overrides.json",
      "utf8"
    )
  );

  const previousWeek =
    history.weeks?.length
      ? history.weeks[history.weeks.length - 1]
      : null;

  const previousAssignments = new Set([
    ...(previousWeek?.assigned?.conductor || []),
    ...(previousWeek?.assigned?.vip || [])
  ]);

  const unavailable = new Set(
    (overrides.unavailable || []).map(item =>
      typeof item === "string"
        ? item
        : String(item.name || "")
    )
  );

  // --------------------------------------------------
  // ELIGIBILITY
  // --------------------------------------------------

  const eligible = [];
  const audit = [];

  for (const member of activeMembers) {
    const memberDonations =
      donationMap.get(member.id) || 0n;

    const memberVS =
      vsMap.get(member.id) || 0n;

    const reasons = [];

    if (
      memberDonations <
      BigInt(MIN_DONATIONS)
    ) {
      reasons.push(
        "Below 30,000 weekly Tech Donations"
      );
    }

    if (
      previousAssignments.has(member.name)
    ) {
      reasons.push(
        "Conductor/VIP assigned previous week"
      );
    }

    if (unavailable.has(member.name)) {
      reasons.push("Marked unavailable");
    }

    if (memberVS === 0n) {
      reasons.push(
        "No VS score imported for selected FarmOps week"
      );
    }

    if (reasons.length) {
      audit.push({
        name: member.name,
        status: "INELIGIBLE",
        vs: memberVS.toString(),
        donations: memberDonations.toString(),
        reasons
      });

      continue;
    }

    eligible.push({
      name: member.name,
      vs: memberVS,
      donations: memberDonations
    });
  }

  console.log(
    `Eligible members: ${eligible.length}`
  );

  if (eligible.length < 8) {
    throw new Error(
      `Need at least 8 eligible members. ` +
      `Only ${eligible.length} were found.`
    );
  }

  // --------------------------------------------------
  // NORMALIZATION
  // --------------------------------------------------

  const maximumVS = eligible.reduce(
    (max, member) =>
      member.vs > max
        ? member.vs
        : max,
    0n
  );

  const maximumDonations =
    eligible.reduce(
      (max, member) =>
        member.donations > max
          ? member.donations
          : max,
      0n
    );

  // --------------------------------------------------
  // 70 / 30 FORMULA
  // --------------------------------------------------

  for (const member of eligible) {
    const vsNormalized =
      normalize(
        member.vs,
        maximumVS
      );

    const donationNormalized =
      normalize(
        member.donations,
        maximumDonations
      );

    const finalScore =
      (vsNormalized * 0.70) +
      (donationNormalized * 0.30);

    member.finalScore = finalScore;

    audit.push({
      name: member.name,
      status: "ELIGIBLE",
      vs: member.vs.toString(),
      donations:
        member.donations.toString(),
      vs_normalized:
        Number(vsNormalized.toFixed(2)),
      donation_normalized:
        Number(donationNormalized.toFixed(2)),
      final:
        Number(finalScore.toFixed(2))
    });
  }

  eligible.sort(
    (a, b) =>
      b.finalScore - a.finalScore
  );

  const take = () =>
    eligible.shift().name;

  // --------------------------------------------------
  // SELECTIONS
  // --------------------------------------------------

  const selections = {
    conductor: {
      primary: take(),
      alternates: [
        take(),
        take(),
        take()
      ]
    },

    vip: {
      primary: take(),
      alternates: [
        take(),
        take(),
        take()
      ]
    }
  };

  // --------------------------------------------------
  // RESULTS
  // --------------------------------------------------

  const results = {
    schema_version: 1,
    status: "PROPOSED",
    source: "FarmOps API",

    alliance:
      alliance.name || "FEAR",

    week:
      `${weekStart} to ${weekEnd}`,

    generated_at:
      new Date().toISOString(),

    formula: {
      minimum_donations:
        MIN_DONATIONS,
      vs_weight: 0.70,
      donation_weight: 0.30,
      random_weight: 0.00,
      cooldown:
        "Anyone actually assigned Conductor or VIP in the previous week is excluded."
    },

    data_summary: {
      active_members:
        activeMembers.length,
      eligible_members:
        audit.filter(
          item =>
            item.status === "ELIGIBLE"
        ).length
    },

    selections,
    audit
  };

  // --------------------------------------------------
  // WEEKLY 7-DAY SCHEDULE
  // Generated once by GitHub Actions after Saturday reset.
  // The website only displays this committed result.
  // --------------------------------------------------
  const schedulePool = audit
    .filter(item => item.status === "ELIGIBLE")
    .map(item => ({ ...item }))
    .sort((a, b) => (b.final || 0) - (a.final || 0));

  if (schedulePool.length < 14) {
    throw new Error("Need at least 14 eligible members to create the 7-day schedule.");
  }

  const scheduleUsed = new Set();
  const takeScheduleMember = () => {
    const member = schedulePool.find(item => !scheduleUsed.has(item.name));
    if (!member) throw new Error("Not enough unique members for 7-day schedule.");
    scheduleUsed.add(member.name);
    return member;
  };

  // FEAR Train week runs Sunday through Saturday. FarmOps weekEnd is Sunday, so Day 1 starts on weekEnd.
  const scheduleStart = weekEnd;
  const days = [];

  for (let i = 0; i < 7; i++) {
    const conductor = takeScheduleMember();
    const vip = takeScheduleMember();
    const remaining = schedulePool.filter(item => !scheduleUsed.has(item.name));

    days.push({
      date: addDays(scheduleStart, i),
      conductor: {
        primary: conductor.name,
        score: conductor.final,
        alternates: remaining.slice(0, 3).map(item => item.name)
      },
      vip: {
        primary: vip.name,
        score: vip.final,
        alternates: remaining.slice(3, 6).map(item => item.name)
      }
    });
  }

  const weeklySchedule = {
    schema_version: 1,
    status: "LOCKED",
    source: "FarmOps API via GitHub Actions",
    source_week: `${weekStart} to ${weekEnd}`,
    schedule_week: `${scheduleStart} to ${addDays(scheduleStart, 6)}`,
    generated_at: new Date().toISOString(),
    days
  };

  fs.writeFileSync(
    "data/train-7-day.json",
    JSON.stringify(weeklySchedule, null, 2) + "\n"
  );

  fs.writeFileSync(
    "data/train-results.json",
    JSON.stringify(
      results,
      null,
      2
    ) + "\n"
  );

  console.log("");
  console.log(
    "FEAR TRAIN DRAW COMPLETE"
  );

  console.log(
    JSON.stringify(
      selections,
      null,
      2
    )
  );
}

generate().catch(error => {
  console.error(
    "TRAIN GENERATOR ERROR:",
    error.message
  );

  process.exit(1);
});
