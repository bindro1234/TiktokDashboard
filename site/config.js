// Website configuration. No keys or secrets belong here: the site only reads the
// PUBLIC data sheet (TikTok handles only), published via File > Share > Publish to web.
window.TT_CONFIG = {
  sheetId: "1syVgGLY2t8XnllGAkWSVvGXmElDJW7ng2pLVQKSXWjA",
  // Tab ids (gid) inside the public sheet.
  gids: { handles: 0, history: 127434821, posts: 2114443715 },
  // "Publish to web" link id (the part after /d/e/, starting with 2PACX-). Required: a sheet
  // that is published but not shared by link is only served through this id.
  publishedId: "2PACX-1vTcErigCeOR2PncRcPTm11YH09aUMkoOq6uS_yKQVeBWBNn4ZQIYJ1g69kW6NmWKFlOR9_-pIAKOiks",
  campaignStart: "2026-09-28",
  campaignEnd: "2026-10-26",
  refreshMinutes: 10,
  // "Nu verversen" workflow page, shown to the admin via ?beheerder. Starting it
  // requires being logged in to GitHub with write access; the site holds no tokens.
  forceRefreshUrl: "https://github.com/bindro1234/TiktokDashboard/actions/workflows/force-refresh.yml",
};

window.TT_CONFIG.csvUrl = function (tab) {
  const c = window.TT_CONFIG;
  const gid = c.gids[tab];
  if (c.publishedId) {
    return `https://docs.google.com/spreadsheets/d/e/${c.publishedId}/pub?gid=${gid}&single=true&output=csv`;
  }
  return `https://docs.google.com/spreadsheets/d/${c.sheetId}/pub?gid=${gid}&single=true&output=csv`;
};
