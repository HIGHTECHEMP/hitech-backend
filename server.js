// backend/server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import nodemailer from "nodemailer";
import { v4 as uuidv4 } from "uuid";

dotenv.config();
const app = express();
app.use(cors({
  origin: [
    "https://hightechemp.site", // your frontend (Hostinger)
    "https://www.hightechemp.site" // optional, in case www version is used
  ],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  credentials: true,
}));

app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));

/*
  In-memory demo DB:
  - users: { id, name, email, password, verified, balance, referralEarnings, referralCode, subscribedAt, lastEarningWithdrawal, packageId, referrals:[] }
  - deposits: { id, userId, amount, status, txId, createdAt, promoApplied }
  - withdrawals: { id, userId, type, amount, bank, accountNumber, accountName, status, createdAt }
  - adsWatched: track per-user per-day how many ads they've watched
*/
const users = [];
const deposits = [];
const withdrawals = [];
const adsWatched = {}; // { userId: { yyyy-mm-dd: count } }
const verifications = {}; // email -> code
const promo = { limit: Number(process.env.PROMO_LIMIT || 300), used: 0 };

// Packages (exact amounts you requested)
const PACKAGES = [
  { id: 1, price: 5000, daily: 500 },
  { id: 2, price: 10000, daily: 1000 },
  { id: 3, price: 25000, daily: 2500 },
  { id: 4, price: 50000, daily: 5000 },
  { id: 5, price: 100000, daily: 10000 }
];

const transporter = nodemailer.createTransport({
  service: "gmail",
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});




// create demo admin user if missing
const adminEmail = process.env.ADMIN_EMAIL || "oparahraymond72@gmail.com";
if (!users.find(u => u.email === adminEmail)) {
  users.push({
    id: "user_admin",
    name: "Admin",
    email: adminEmail,
    password: process.env.ADMIN_PASS || "admin123",
    verified: true,
    balance: 0,
    referralEarnings: 0,
    referralCode: "ADMIN",
    referrals: [],
    role: "admin",
    createdAt: new Date()
  });
}

/* --------------------
  Helpers
---------------------*/
function nowISO() { return new Date().toISOString(); }
function findUserByEmail(email){ return users.find(u => u.email.toLowerCase() === (email||"").toLowerCase()); }
function findUserById(id){ return users.find(u => u.id === id); }
function sendAdminEmail(subject, html) {
  if (!transporter) return Promise.resolve();
  return transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: process.env.ADMIN_EMAIL || adminEmail,
    subject,
    html
  }).catch(err => console.warn("Admin email error", err));
}

/* --------------------
  Landing / info
---------------------*/
app.get("/", (req, res) => {
  res.send("HIGHTECH backend running");
});

// front-end video guide / how it works / logo info
app.get("/api/siteinfo", (req,res) => {
  res.json({
    siteName: "HIGHTECH",
    logoText: "HIGHTECH",
    welcome: "Welcome to HIGHTECH — watch ads, earn daily, withdraw later!",
    howItWorks: [
      "Signup or login",
      "Deposit and choose a package",
      "Watch 5 ads daily",
      "Refer friends to earn 10% of their package",
      "Withdraw per rules (admin approves withdrawals)"
    ],
    videoGuide: { title: "How HIGHTECH works", embed: process.env.VIDEO_EMBED_URL || "https://www.youtube.com/embed/dQw4w9WgXcQ" },
    promo: { limit: promo.limit, used: promo.used }
  });
});

/* --------------------
  Auth & verification
---------------------*/
// ✅ SIGNUP — no email verification
app.post("/api/auth/signup", (req, res) => {
  try {
    const { name, email, password, referralCode } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    if (findUserByEmail(email)) {
      return res.status(400).json({ success: false, message: "Email already registered" });
    }

    let referredBy = null;
    if (referralCode) {
      const refUser = users.find(u => u.referralCode === referralCode);
      if (refUser) {
        referredBy = referralCode;
        refUser.referrals.push(email);
      }
    }

    const newUser = {
      id: "u_" + Date.now(),
      name,
      email: email.toLowerCase(),
      password,
      verified: true,
      balance: 0,
      referralEarnings: 0,
      referrals: [],
      referralCode: (email.split("@")[0] + Math.floor(Math.random() * 9000)).toUpperCase(),
      referredBy,
      createdAt: new Date(),
    };
    users.push(newUser);

    console.log(`✅ New signup: ${email}`);

    return res.json({
      success: true,
      message: "Signup successful",
      user: { id: newUser.id, email: newUser.email, name: newUser.name },
    });
  } catch (err) {
    console.error("Signup error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

app.post("/api/auth/verify", (req,res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ success:false, message:"Missing fields" });
  const expected = verifications[email.toLowerCase()];
  if (!expected || expected !== code) return res.status(400).json({ success:false, message:"Invalid code" });
  const user = findUserByEmail(email);
  if (!user) return res.status(404).json({ success:false, message:"User not found" });
  user.verified = true;
  delete verifications[email.toLowerCase()];
  return res.json({ success:true, message:"Email verified" });
});

// login
app.post("/api/auth/login", (req,res) => {
  const { email, password } = req.body;
  const user = findUserByEmail(email);
  if (!user) return res.status(401).json({ success:false, message:"Invalid credentials" });
  if (user.password !== password) return res.status(401).json({ success:false, message:"Invalid credentials" });
  if (!user.verified) return res.status(403).json({ success:false, message:"Please verify email" });
  // return minimal safe user
  const safe = { id: user.id, name: user.name, email: user.email, balance: user.balance, referralEarnings: user.referralEarnings, referralCode: user.referralCode, packageId: user.packageId, subscribedAt: user.subscribedAt };
  return res.json({ success:true, user: safe });
});

/* --------------------
  Packages & subscription
---------------------*/

// list packages
app.get("/api/packages", (req,res) => res.json({ success:true, packages: PACKAGES }));

// subscribe: user must have deposited the package price to balance OR we can force deposit flow
// For simplicity: frontend will call /api/subscribe after deposit success to mark subscription.
app.post("/api/subscribe", (req,res) => {
  const { userId, packageId } = req.body;
  const user = findUserById(userId);
  if (!user) return res.status(404).json({ success:false, message:"User not found" });
  const pkg = PACKAGES.find(p => p.id === Number(packageId) || p.id === packageId);
  if (!pkg) return res.status(400).json({ success:false, message:"Invalid package" });
  if (user.balance < pkg.price) return res.status(400).json({ success:false, message:"Insufficient balance. Please deposit the package amount." });

  // deduct price, set subscription date
  user.balance -= pkg.price;
  user.packageId = pkg.id;
  user.subscribedAt = new Date();

  // credit referral: 10% of package price to referrer (immediate)
  if (user.referredBy) {
    const refUser = users.find(u => u.referralCode === user.referredBy);
    if (refUser) {
      const bonus = Math.round(pkg.price * 0.10);
      refUser.referralEarnings = (refUser.referralEarnings || 0) + bonus;
      // record deposit-like referral record if desired
    }
  }

  return res.json({ success:true, message:"Subscribed to package", user:{ balance:user.balance, packageId:user.packageId } });
});

/* --------------------
  Deposit (Flutterwave init) + callback verify and auto-credit
---------------------*/

app.post("/api/deposit", async (req, res) => {
  try {
    const { email, amount, name } = req.body;

    if (!amount || Number(amount) < 5000) {
      return res.status(400).json({ success: false, message: "Minimum deposit is ₦5,000" });
    }

    // Flutterwave payment init
    const response = await fetch("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tx_ref: "hitech_" + Date.now(),
        amount: String(amount),
        currency: "NGN",
        // ✅ LIVE REDIRECT URL FIXED HERE
        redirect_url: `https://hitech-backend.onrender.com/api/payment/callback`,
        customer: { email, name },
        customizations: {
          title: "HIGHTECH Deposit",
          description: "Fund your account",
        },
      }),
    });

    const data = await response.json();
    if (data.status === "success") {
      return res.json({ success: true, link: data.data.link });
    }

    return res.status(400).json({ success: false, message: data.message || "Failed to init payment" });
  } catch (err) {
    console.error("deposit err", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});


// callback from flutterwave
app.get("/api/payment/callback", async (req, res) => {
  try {
    const { status, transaction_id, tx_ref } = req.query;
    if (status !== "successful") return res.send("<h2>Payment not successful</h2>");

    // ✅ Verify transaction with Flutterwave
    const verifyRes = await fetch(`https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`, {
      headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` }
    });
    const verifyData = await verifyRes.json();
    if (!verifyData || verifyData.status !== "success") {
      console.error("verifyData", verifyData);
      return res.send("<h2>Payment verification failed</h2>");
    }

    const { amount, customer } = verifyData.data;
    const email = (customer?.email || "").toLowerCase();
    let user = findUserByEmail(email);

    // ✅ Auto-create user if not found
    if (!user) {
      user = {
        id: "u_" + Date.now(),
        name: customer?.name || "HIGHTECH User",
        email,
        password: "",
        verified: true,
        balance: 0,
        referralEarnings: 0,
        referrals: [],
        referralCode: (email.split("@")[0] + Math.floor(Math.random() * 9000)).toUpperCase(),
        createdAt: new Date(),
      };
      users.push(user);
    }

    // ✅ Credit deposit amount to balance
    user.balance = (user.balance || 0) + Number(amount);

    // ✅ Record deposit and check promo
    let promoApplied = false;
    if (promo.used < promo.limit) {
      promo.used += 1;
      promoApplied = true;
    }

    const dep = {
      id: uuidv4(),
      userId: user.id,
      amount: Number(amount),
      txId: transaction_id,
      txRef: tx_ref || null,
      status: "successful",
      createdAt: new Date(),
      promoApplied,
    };
    deposits.push(dep);

    console.log(`✅ Deposit credited: ₦${amount} for ${email} (Promo: ${promoApplied})`);

    // ✅ Redirect to live frontend dashboard
    return res.redirect("https://hightechemp.site/dashboard");
  } catch (err) {
    console.error("callback err", err);
    return res.status(500).send("<h2>Error verifying payment</h2>");
  }
});


/* --------------------
  Webhook (flutterwave)
---------------------*/
app.post("/api/webhook/flutterwave", (req,res) => {
  // Keep placeholder; verify signature in production, credit as needed
  console.log("webhook payload", req.body);
  res.json({ success:true });
});

/* --------------------
  Banks + verify account name
---------------------*/
// ✅ Get list of Nigerian banks (with Flutterwave + fallback)
app.get("/api/banks", async (req, res) => {
  try {
    const response = await fetch("https://api.flutterwave.com/v3/banks/NG", {
      headers: {
        Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
      },
    });

    const data = await response.json();

    // If Flutterwave returns valid bank data
    if (data && data.data && Array.isArray(data.data)) {
      return res.json(data.data);
    } else {
      throw new Error("Invalid bank data from Flutterwave");
    }

  } catch (error) {
    console.error("banks error:", error.message);

    // 👇 fallback bank list so frontend doesn’t break
    return res.json([
      { code: "044", name: "Access Bank" },
      { code: "011", name: "First Bank of Nigeria" },
      { code: "058", name: "GTBank" },
      { code: "033", name: "UBA" },
      { code: "232", name: "Sterling Bank" },
      { code: "221", name: "Stanbic IBTC Bank" },
      { code: "068", name: "Standard Chartered Bank" },
      { code: "101", name: "Providus Bank" },
      { code: "076", name: "Polaris Bank" },
      { code: "082", name: "Keystone Bank" },
    ]);
  }
});


app.post("/api/verify-account", async (req,res) => {
  try {
    const { account_number, account_bank } = req.body;
    if (!account_number || !account_bank) return res.status(400).json({ success:false, message:"Missing fields" });
    const r = await fetch("https://api.flutterwave.com/v3/accounts/resolve", {
      method:"POST",
      headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`, "Content-Type":"application/json" },
      body: JSON.stringify({ account_number, account_bank })
    });
    const data = await r.json();
    if (data.status === "success") return res.json({ success:true, account_name: data.data.account_name, account_number: data.data.account_number });
    return res.status(400).json({ success:false, message: data.message || "Verification failed" });
  } catch (err) {
    console.error("verify err", err);
    return res.status(500).json({ success:false, message:"Server error" });
  }
});

/* --------------------
  Withdraw request (manual)
  - referral withdrawal: min 5000, withdraw anytime
  - earning withdrawal: allowed only every 7 days from subscription or last withdrawal
---------------------*/
app.post("/api/withdraw", async (req,res) => {
  try {
    const { userId, type, amount, bank, accountNumber, accountName } = req.body;
    const user = findUserById(userId);
    if (!user) return res.status(404).json({ success:false, message:"User not found" });

    const amt = Number(amount || 0);
    if (!amt || amt <= 0) return res.status(400).json({ success:false, message:"Invalid amount" });

    if (type === "referral") {
      if (user.referralEarnings < 5000) return res.status(400).json({ success:false, message:"Referral minimum withdrawal is ₦5,000" });
      if (amt > user.referralEarnings) return res.status(400).json({ success:false, message:"Not enough referral balance" });
      user.referralEarnings -= amt;
    } else if (type === "earning") {
      // check 7 days rule
      const allowFrom = user.subscribedAt ? new Date(user.subscribedAt) : null;
      const last = user.lastEarningWithdrawal ? new Date(user.lastEarningWithdrawal) : allowFrom;
      if (!last) return res.status(400).json({ success:false, message:"You must subscribe to a package first" });
      const daysSince = (Date.now() - last.getTime()) / (1000*60*60*24);
      if (daysSince < 7) return res.status(400).json({ success:false, message:"Earning withdrawals allowed once every 7 days" });
      if (amt > user.balance) return res.status(400).json({ success:false, message:"Insufficient wallet balance" });
      user.balance -= amt;
      user.lastEarningWithdrawal = new Date();
    } else {
      return res.status(400).json({ success:false, message:"Invalid withdrawal type" });
    }

    // create withdraw request (admin will approve)
    const w = { id: uuidv4(), userId: user.id, type, amount: amt, bank, accountNumber, accountName, status: "pending", createdAt: new Date() };
    withdrawals.push(w);

    // notify admin by email
    const subject = `New withdrawal request (${type}) ₦${amt}`;
    const html = `<p>User ${user.email} requested withdrawal ₦${amt} - ${type}</p>
                  <p>Account: ${accountName} (${accountNumber}), Bank: ${bank}</p>`;
    sendAdminEmail(subject, html).catch(e=>console.warn("notify admin err", e));

    return res.json({ success:true, withdrawal: w, message:"Withdrawal request placed. Admin will process within 24 hours." });
  } catch (err) {
    console.error("withdraw err", err);
    return res.status(500).json({ success:false, message:"Server error" });
  }
});

/* --------------------
  Admin endpoints
---------------------*/
app.get("/api/admin/withdrawals", (req,res) => res.json({ success:true, withdrawals }));
app.get("/api/admin/deposits", (req,res) => res.json({ success:true, deposits }));
app.get("/api/admin/users", (req,res) => res.json({ success:true, users: users.map(u => ({ id:u.id, email:u.email, name:u.name, balance:u.balance, referralEarnings:u.referralEarnings })) }));

// approve withdrawal (admin)
app.post("/api/admin/withdrawals/:id/approve", (req,res) => {
  const id = req.params.id;
  const w = withdrawals.find(x => x.id === id);
  if (!w) return res.status(404).json({ success:false, message:"Not found" });
  w.status = "approved";
  // In production: call payout API or mark as paid after manual transfer
  return res.json({ success:true, w });
});

/* --------------------
  Ads / watch tracking endpoints
  - mark watched ad (frontend calls when ad finished)
  - get remaining ads count for user today (max 5)
---------------------*/
app.post("/api/ads/watch", (req,res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ success:false, message:"Missing userId" });
  const d = new Date(); const key = d.toISOString().slice(0,10);
  if (!adsWatched[userId]) adsWatched[userId] = {};
  if (!adsWatched[userId][key]) adsWatched[userId][key] = 0;
  if (adsWatched[userId][key] >= 5) return res.status(400).json({ success:false, message:"Daily ad limit reached" });
  adsWatched[userId][key] += 1;
  // credit daily earning only when user has package and only after watching 5 ads? Business rule: you said "watch 5 ads daily" — assume earnings accumulate daily and admin/manual cron handles daily credit. For demo we will not auto-credit here.
  return res.json({ success:true, watched: adsWatched[userId][key] });
});

app.get("/api/ads/status", (req,res) => {
  const { userId } = req.query;
  if (!userId) return res.json({ success:true, remaining:5 });
  const key = (new Date()).toISOString().slice(0,10);
  const count = (adsWatched[userId] && adsWatched[userId][key]) || 0;
  return res.json({ success:true, watched: count, remaining: Math.max(0,5-count) });
});

/* --------------------
  Promo & stats endpoint
--------------------*/
app.get("/api/promo", (req,res) => {
  return res.json({ success:true, limit: promo.limit, used: promo.used, remaining: Math.max(0, promo.limit - promo.used) });
});

// near top of server.js - set base starters (can also use env vars)
const BASE_USERS = Number(process.env.BASE_USERS || 10000);
const BASE_DEPOSITS = Number(process.env.BASE_DEPOSITS || 9500);

// statistics + rotating testimonials endpoint
app.get("/api/stats", (req, res) => {
  try {
    // real counts from in-memory arrays
    const realUsersCount = users.length;         // actual signed up users in memory
    const realDepositsTotal = deposits.reduce((s, d) => s + (d.amount || 0), 0);
    const realDepositsCount = deposits.length;  // or total amount if you prefer

    // combine baseline + real
    const totalUsers = BASE_USERS + realUsersCount;
    const totalDepositCount = BASE_DEPOSITS + realDepositsCount;
    const totalDepositAmount = (BASE_DEPOSITS * 5000) + realDepositsTotal; 
    // (note: above uses assumption baseline deposit amount — adjust if you want to treat baseline as count or amount)

    // rotating/fresh testimonials: store array and pick different ordering each call
    const testimonialsPool = [
      { name: "Ada", text: "I started earning within days!" },
      { name: "Chidi", text: "Reliable payouts — I love HIGHTECH" },
      { name: "Amaka", text: "Simple and transparent." },
      { name: "Sule", text: "Great UX and smooth withdrawals." },
      { name: "Ife", text: "Earned daily with no stress." }
    ];

    // Rotate testimonials by shifting starting index using time (gives change across requests)
    const idx = Math.floor(Date.now() / (1000 * 60 * 60)) % testimonialsPool.length; // changes every hour
    const rotated = testimonialsPool.slice(idx).concat(testimonialsPool.slice(0, idx));

    return res.json({
      success: true,
      stats: {
        users: totalUsers,
        depositsCount: totalDepositCount,
        depositsAmount: totalDepositAmount,
        dailyActive: Math.min(totalUsers, Math.floor(Math.random() * 200) + 5)
      },
      testimonials: rotated.slice(0, 3) // send top 3 in rotating order
    });
  } catch (err) {
    console.error("stats err", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});


/* --------------------
  Video guide endpoint
--------------------*/
app.get("/api/video-guide", (req,res) => {
  res.json({ success:true, embed: process.env.VIDEO_EMBED_URL || "https://www.youtube.com/embed/dQw4w9WgXcQ", text:"How HIGHTECH works" });
});

/* --------------------
  Serve production frontend (optional)
---------------------*/
// If you build frontend to ../frontend/build, uncomment serving block below
/*
import path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname,"../frontend/build")));
app.get("*",(req,res) => res.sendFile(path.join(__dirname,"../frontend/build","index.html")));
*/
/* --------------------
  New endpoint: /api/watch-ad
  Tracks ads watched and auto-rewards ROI when all 5 are done
---------------------*/
app.post("/api/watch-ad", (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: "Missing userId" });

    const user = findUserById(userId);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    if (!user.packageId) return res.status(400).json({ success: false, message: "You must subscribe to a package first" });

    const today = new Date().toISOString().slice(0, 10);

    // init tracking if not exist
    if (!adsWatched[userId]) adsWatched[userId] = {};
    if (!adsWatched[userId][today]) adsWatched[userId][today] = { count: 0, rewarded: false };

    const userAds = adsWatched[userId][today];

    // Check if already rewarded
    if (userAds.rewarded) {
      return res.json({ success: false, message: "Today's ROI already credited", watched: 5 });
    }

    // Increment watch count
    if (userAds.count >= 5) {
      return res.json({ success: false, message: "Daily ad limit reached", watched: 5 });
    }

    userAds.count += 1;

    // When 5 ads watched, credit ROI
    if (userAds.count === 5) {
      const pkg = PACKAGES.find(p => p.id === user.packageId);
      if (pkg) {
        user.balance = (user.balance || 0) + pkg.daily; // credit ROI
        userAds.rewarded = true;
        console.log(`💰 Credited ₦${pkg.daily} ROI to ${user.email}`);
      }
    }

    return res.json({
      success: true,
      message:
        userAds.count === 5
          ? "✅ You’ve completed today’s 5 ads. ROI credited to your wallet!"
          : `Ad ${userAds.count}/5 watched successfully.`,
      watched: userAds.count,
      rewarded: userAds.rewarded,
      newBalance: user.balance,
    });
  } catch (err) {
    console.error("watch-ad err", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 HIGHTECH backend listening on ${PORT}`));
