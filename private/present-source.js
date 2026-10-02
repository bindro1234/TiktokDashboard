
// ---- Private dashboard only (appended by private/build.sh; never on the public site) ----
// Presentation data comes from the Worker API (behind Cloudflare Access) and includes the
// students' first names as labels.
window.TT_CONFIG.refreshMinutes = 5;
window.TT_CONFIG.source = async function () {
  const res = await fetch("/api/data", { cache: "no-store", credentials: "same-origin" });
  if (res.status === 403) throw new Error("Geen toegang meer. Laad de pagina opnieuw om opnieuw in te loggen.");
  if (!res.ok) throw new Error(`Server gaf HTTP ${res.status}`);
  const d = await res.json();
  const labels = {};
  for (const a of d.accounts) if (a.tracked && a.name) labels[a.handle] = a.name.split(" ")[0];
  // Students with two accounts: the private sheet knows right away (the public handles tab after the next run).
  const groupOf = new Map(d.accounts.filter((a) => a.tracked).map((a) => [a.handle, a.group]));
  const handles = d.handles.map((h) => ({ ...h, group: groupOf.get(String(h.handle)) || h.group || h.handle }));
  // The finale state (start/end in ms, or null) comes from the private sheet via the Worker.
  return { handles, history: d.history, posts: d.posts, labels, finale: d.finale || null, outliers: d.outliers || [] };
};
// Per-video history (account pages, Video's) also through the Worker, like the rest of the data.
window.TT_CONFIG.postHistorySource = async function () {
  const res = await fetch("/api/post-history", { cache: "no-store", credentials: "same-origin" });
  if (!res.ok) throw new Error(`Server gaf HTTP ${res.status}`);
  const { rows } = await res.json();
  return rows.map(([id, t, views]) => ({ video_id: id, timestamp: new Date(t).toISOString(), views }));
};
