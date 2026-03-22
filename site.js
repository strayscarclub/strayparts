const SUPABASE_URL = "https://gapajajlaerwfuqrdboz.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdhcGFqYWpsYWVyd2Z1cXJkYm96Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwMjI5ODIsImV4cCI6MjA4ODU5ODk4Mn0.sQ_WUObhZLHIPpEvO7lUjysHw58hNn_Pw6c4dft9hi8";
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function getCurrentUser() {
  const { data: authData } = await supabaseClient.auth.getUser();
  return authData.user || null;
}

async function getCurrentProfile() {
  const user = await getCurrentUser();
  if (!user) return null;

  const { data: profile } = await supabaseClient
    .from("profiles")
    .select("plan, upgarage_acknowledged")
    .eq("id", user.id)
    .single();

  return profile || null;
}

async function loadAccountBar(options = {}) {
  const {
    currentPage = "",
    requireAuth = false
  } = options;

  const accountBar = document.getElementById("account-bar");
  if (!accountBar) return null;

  const user = await getCurrentUser();

  if (requireAuth && !user) {
    window.location.href = "/login.html";
    return null;
  }

  if (user) {
    if (currentPage === "my-garage") {
      accountBar.innerHTML = `
        <span class="active-link">My Garage</span>
        <button onclick="logOut()">Log Out</button>
      `;
    } else {
      accountBar.innerHTML = `
        <a href="/my-garage.html">My Garage</a>
        <button onclick="logOut()">Log Out</button>
      `;
    }
  } else {
    accountBar.innerHTML = `
      <a href="/login.html">Log In</a>
      <a href="/signup.html">Sign Up</a>
    `;
  }

  return user;
}

async function logOut() {
  await supabaseClient.auth.signOut();
  window.location.href = "/";
}

function formatPlan(plan) {
  if (plan === "builder") return "Builder";
  if (plan === "collector") return "Collector";
  return "Free";
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeJs(str) {
  return String(str || "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, " ");
}

function renderSiteFooter() {
  return `
    <footer class="site-footer">
      <p class="footer-copy">
        Stray Parts helps you find rare JDM parts across eBay, Yahoo Auctions and Up Garage — then alerts you when the part you want appears.
      </p>

      <div class="footer-nav">
        <a href="/">Home</a>
        <a href="/about.html">About</a>
        <a href="/feedback.html">Feedback</a>
        <a href="/privacy.html">Privacy</a>
        <a href="/pricing.html">Pricing</a>
      </div>

      <p class="footer-meta">© Stray Parts</p>
    </footer>
  `;
}

function mountSiteFooter(targetId = "site-footer") {
  const target = document.getElementById(targetId);
  if (!target) return;
  target.innerHTML = renderSiteFooter();
}
