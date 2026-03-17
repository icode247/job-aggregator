const tests = [
  { name: "SmartRecruiters", mod: "./src/adapters/smartrecruiters", slug: "visa" },
  { name: "Rippling", mod: "./src/adapters/rippling", slug: "rippling" },
  { name: "Personio", mod: "./src/adapters/personio", slug: "expatrio" },
];

(async () => {
  for (const t of tests) {
    console.log("\n========== " + t.name + " (" + t.slug + ") ==========");
    try {
      const adapter = require(t.mod);
      const r = await adapter.fetchJobs(t.slug);
      console.log("Total jobs:", r.jobs.length);
      console.log("Meta:", JSON.stringify(r.meta));

      const sample = r.jobs.slice(0, 3);
      sample.forEach((j, i) => {
        console.log("\n--- Job " + (i + 1) + " ---");
        console.log("external_id:", j.external_id);
        console.log("title:", j.title);
        console.log("department:", j.department);
        console.log("location:", j.location);
        console.log("workplace_type:", j.workplace_type);
        console.log("employment_type:", j.employment_type);
        console.log("description:", j.description ? j.description.length + " chars" : "NULL");
        console.log("url:", j.url);
        console.log("posted_at:", j.posted_at);
        console.log("salary:", j.salary_min, j.salary_max, j.salary_currency);
      });
    } catch (e) {
      console.log("ERROR:", e.message);
    }
  }
})();
