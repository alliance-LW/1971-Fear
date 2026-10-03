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

  return body.data || [];
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

async function generate() {
  console.log("Connecting to FarmOps...");

  const [alliance, members, duels, donations] = await Promise.all([
    farmOps("/alliance"),
    farmOps("/alliance/members"),
    farmOps("/alliance/members/duels"),
    farmOps("/alliance/members/donations")
  ]);

  // ACTIVE FEAR MEMBERS ONLY
  const activeMembers = members.filter(
    member => member.status === "ACTIVE"
  );

  const activeIds = new Set(
    activeMembers.map(member => member.id)
  );

  console.log(`Active members: ${activeMembers.length}`);

  // -------------------------
  // FIND CURRENT FARMOPS WEEK
  // -------------------------

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

  console.log(`FarmOps week: ${weekStart} through ${weekEnd}`);

  // -------------------------
  // DONATIONS
  // -------------------------

  const donationMap = new Map();

  for (const row of donationRows) {
    if (row.weekStart === weekStart) {
      donationMap.set(
        row.memberId,
        toBigInt(row.total)
      );
    }
  }

  // -------------------------
  // VS SCORES
  // -------------------------

  const vsMap = new Map();

  for (const row of duels) {
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

  // -------------------------
  // HISTORY / OVERRIDES
  // -------------------------

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

  // -------------------------
  // ELIGIBILITY
  // -------------------------

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

  console.log(`Eligible members: ${eligible.length}`);

  // -------------------------
  // DIAGNOSTIC LOGGING
  // -------------------------

  const reasonCounts = {};

  for (const member of audit) {
    if (member.status === "INELIGIBLE") {
      for (const reason of member.reasons) {
        reasonCounts[reason] =
          (reasonCounts[reason] || 0) + 1;
      }
    }
  }

  console.log("");
  console.log("INELIGIBILITY BREAKDOWN:");
  console.log(reasonCounts);

  console.log("");
  console.log("FARMOPS DATA COUNTS:");
  console.log(`Members returned: ${members.length}`);
  console.log(`Donation rows returned: ${donations.length}`);
  console.log(`VS rows returned: ${duels.length}`);
  console.log(`Donation members mapped this week: ${donationMap.size}`);
  console.log(`VS members mapped this week: ${vsMap.size}`);

  console.log("");
  console.log("SAMPLE FARMOPS DONATION ROW:");
  console.log(donations[0] || "NO DONATION ROWS RETURNED");

  console.log("");
  console.log("SAMPLE FARMOPS VS ROW:");
  console.log(duels[0] || "NO VS ROWS RETURNED");

  console.log("");
  console.log("SAMPLE ACTIVE MEMBER:");
  console.log(activeMembers[0] || "NO ACTIVE MEMBERS RETURNED");

  console.log("");

  // -------------------------
  // MINIMUM ELIGIBLE CHECK
  // -------------------------

  if (eligible.length < 8) {
    throw new Error(
      `Need at least 8 eligible members. Only ${eligible.length} were found. Check FarmOps VS imports, donations, cooldowns and unavailable members.`
    );
  }

  // -------------------------
  // NORMALIZATION
  // -------------------------

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

  // -------------------------
  // 40 / 30 / 30 FORMULA
  // -------------------------

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

    const randomScore =
      crypto.randomInt(0, 10001) / 100;

    const finalScore =
      (vsNormalized * 0.40) +
      (donationNormalized * 0.30) +
      (randomScore * 0.30);

    member.finalScore = finalScore;

    audit.push({
      name: member.name,
      status: "ELIGIBLE",

      vs:
        member.vs.toString(),

      donations:
        member.donations.toString(),

      vs_normalized:
        Number(
          vsNormalized.toFixed(2)
        ),

      donation_normalized:
        Number(
          donationNormalized.toFixed(2)
        ),

      random:
        Number(
          randomScore.toFixed(2)
        ),

      final:
        Number(
          finalScore.toFixed(2)
        )
    });
  }

  // Highest score first
  eligible.sort(
    (a, b) =>
      b.finalScore - a.finalScore
  );

  const take = () =>
    eligible.shift().name;

  // -------------------------
  // SELECTIONS
  // -------------------------

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

  // -------------------------
  // RESULTS
  // -------------------------

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

      vs_weight: 0.40,

      donation_weight: 0.30,

      random_weight: 0.30,

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
