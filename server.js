// backend/server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import nodemailer from "nodemailer";
import { v4 as uuidv4 } from "uuid";
import mongoose from "mongoose";

dotenv.config();

const FRONTEND_URL = process.env.FRONTEND_URL || "https://hightechemp.site";
const MONGO_URI = process.env.MONGO_URI;
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;

if (!MONGO_URI) {
  console.error("❌ MONGO_URI not set in .env");
  process.exit(1);
}

mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => {
    console.error("❌ MongoDB connection error", err);
    process.exit(1);
  });

/* ---------------------
  Schemas
----------------------*/
const { Schema } = mongoose;

const UserSchema = new Schema({
  name: String,
  email: { type: String, lowercase: true, index: true, unique: true },
  password: String,
  verified: { type: Boolean, default: true },
  balance: { type: Number, default: 0 },
  referralEarnings: { type: Number, default: 0 },
  referrals: { type: [String], default: [] },
  referralCode: { type: String, index: true },
  referredBy: { type: String, default: null },
  packageId: { type: Number, default: null },
  subscribedAt: Date,
  lastEarningWithdrawal: Date,
  createdAt: { type: Date, default: Date.now }
});

const DepositSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User" },
  email: String,
  amount: Number,
  txId: String,
  txRef: String,
  status: String,
  promoApplied: Boolean,
  createdAt: { type: Date, default: Date.now }
});

const WithdrawalSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User" },
  type: String,
  amount: Number,
  bank: String,
  accountNumber: String,
  accountName: String,
  status: String,
  createdAt: { type: Date, default: Date.now }
});

const PromoSchema = new Schema({
  limit: Number,
  used: Number
});

// Models
const User = mongoose.model("User", UserSchema);
const Deposit = mongoose.model("Deposit", DepositSchema);
const Withdrawal = mongoose.model("Withdrawal", WithdrawalSchema);
const Promo = mongoose.model("Promo", PromoSchema);

/* ---------------------
  Ensure promo doc exists
----------------------*/
async function ensurePromo() {
  let p = await Promo.findOne();
  if (!p) {
    p = new Promo({ limit: Number(process.env.PROMO_LIMIT || 300), used: 0 });
    await p.save();
    console.log("✅ Promo doc created");
  } else {
    console.log("ℹ️ Promo loaded", p.limit, p.used);
  }
}
ensurePromo();

/* ---------------------
  Setup
----------------------*/
const app = express();
app.use(cors({
  origin: [FRONTEND_URL, `https://www.${new URL(FRONTEND_URL).hostname}`],
  methods: ["GET","POST","PUT","DELETE","OPTIONS"],
  credentials: true,
}));
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));

const PACKAGES = [
  { id: 1, price: 5000, daily: 500 },
  { id: 2, price: 10000, daily: 1000 },
  { id: 3, price: 25000, daily: 2500 },
  { id: 4, price: 50000, daily: 5000 },
  { id: 5, price: 100000, daily: 10000 }
];

const transporter = nodemailer.createTransport({
  service: process.env.SMTP_SERVICE || "gmail",
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/* ---------------------
  Helpers
----------------------*/
const nowISO = () => new Date().toISOString();

async function findUserByEmail(email) {
  return User.findOne({ email: (email||"").toLowerCase() });
}

async function findUserById(id) {
  return User.findById(id);
}

/* ---------------------
  Routes
----------------------*/
app.get("/", (req, res) => res.send("HIGHTECH backend running"));

app.get("/api/siteinfo", async (req, res) => {
  const promo = await Promo.findOne();
  res.json({
    siteName: "HIGHTECH",
    logoText: "HIGHTECH",
    welcome: "Welcome to HIGHTECH — watch ads, earn daily!",
    promo: { limit: promo.limit, used: promo.used }
  });
});

/* Auth */
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { name, email, password, referralCode } = req.body;
    if (!name || !email || !password) return res.status(400).json({ success:false, message:"Missing fields" });

    const exists = await User.findOne({ email: email.toLowerCase() });
    if (exists) return res.status(400).json({ success:false, message:"Email already registered" });

    let referredBy = null;
    if (referralCode) {
      const refUser = await User.findOne({ referralCode });
      if (refUser) {
        referredBy = referralCode;
        refUser.referrals.push(email.toLowerCase());
        await refUser.save();
      }
    }

    const referralCodeGenerated = (email.split("@")[0] + Math.floor(Math.random() * 9000)).toUpperCase();

    const user = new User({
      name,
      email: email.toLowerCase(),
      password,
      verified: true,
      referralCode: referralCodeGenerated,
      referredBy,
      balance: 0,
      referralEarnings: 0
    });
    await user.save();

    console.log("✅ New signup", email);
    return res.json({ success:true, message:"Signup successful", user:{ id:user._id, email:user.email, name:user.name, referralCode:user.referralCode } });
  } catch (err) {
    console.error("Signup error", err);
    return res.status(500).json({ success:false, message:"Server error" });
  }
});

app.post("/api/auth/login", async (req,res) => {
  try {
    const { email, password } = req.body;
    const user = await findUserByEmail(email);
    if (!user || user.password !== password) return res.status(401).json({ success:false, message:"Invalid credentials" });
    if (!user.verified) return res.status(403).json({ success:false, message:"Please verify email" });
    const safe = { id: user._id, name: user.name, email: user.email, balance: user.balance, referralEarnings: user.referralEarnings, referralCode: user.referralCode, packageId: user.packageId, subscribedAt: user.subscribedAt };
    return res.json({ success:true, user: safe });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, message:"Server error" });
  }
});

/* Referrals */
app.get("/api/user/:userId/referrals", async (req,res) => {
  try {
    const user = await findUserById(req.params.userId);
    if (!user) return res.status(404).json({ success:false, message:"User not found" });
    const referred = await User.find({ referredBy: user.referralCode }).select("name email createdAt");
    res.json({ success:true, count: referred.length, referrals: referred });
  } catch (err) {
    console.error("Referral fetch error", err);
    res.status(500).json({ success:false, message:"Server error" });
  }
});

/* Packages */
app.get("/api/packages", (req,res) => res.json({ success:true, packages: PACKAGES }));

app.post("/api/subscribe", async (req,res) => {
  try {
    const { userId, packageId } = req.body;
    const user = await findUserById(userId);
    if (!user) return res.status(404).json({ success:false, message:"User not found" });
    const pkg = PACKAGES.find(p => String(p.id) === String(packageId));
    if (!pkg) return res.status(400).json({ success:false, message:"Invalid package" });
    if (user.balance < pkg.price) return res.status(400).json({ success:false, message:"Insufficient balance" });

    user.balance -= pkg.price;
    user.packageId = pkg.id;
    user.subscribedAt = new Date();
    // credit referral earnings if any
    if (user.referredBy) {
      const ref = await User.findOne({ referralCode: user.referredBy });
      if (ref) {
        const bonus = Math.round(pkg.price * 0.10);
        ref.referralEarnings = (ref.referralEarnings || 0) + bonus;
        await ref.save();
      }
    }
    await user.save();
    res.json({ success:true, message:"Subscribed", user: { balance: user.balance, packageId: user.packageId } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success:false, message:"Server error" });
  }
});

/* Deposit init */
app.post("/api/deposit", async (req,res) => {
  try {
    const { email, amount, name } = req.body;
    if (!amount || Number(amount) < 5000) return res.status(400).json({ success:false, message:"Minimum ₦5,000" });

    const tx_ref = "hitech_" + Date.now();
    const response = await fetch("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: { Authorization: `Bearer ${FLW_SECRET_KEY}`, "Content-Type":"application/json" },
      body: JSON.stringify({
        tx_ref,
        amount: String(amount),
        currency: "NGN",
        redirect_url: `${process.env.BACKEND_URL || "https://hitech-backend.onrender.com"}/api/payment/callback`,
        customer: { email, name },
        customizations: { title: "HIGHTECH Deposit" }
      })
    });
    const data = await response.json();
    if (data.status === "success") return res.json({ success:true, link: data.data.link });
    return res.status(400).json({ success:false, message: data.message || "Failed to init payment" });
  } catch (err) {
    console.error("Deposit init error", err);
    res.status(500).json({ success:false, message:"Server error" });
  }
});

/* Payment callback */
app.get("/api/payment/callback", async (req, res) => {
  try {
    const { status, transaction_id, tx_ref } = req.query;
    console.log("🔔 Payment callback:", { status, transaction_id, tx_ref });

    if (status !== "successful") {
      return res.redirect(`${FRONTEND_URL}/dashboard?payment=cancelled`);
    }

    const verifyRes = await fetch(`https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`, {
      headers: { Authorization: `Bearer ${FLW_SECRET_KEY}` }
    });
    const verifyData = await verifyRes.json();
    console.log("🔍 verifyData:", verifyData && verifyData.status ? "OK" : verifyData);

    if (!verifyData || verifyData.status !== "success") {
      return res.redirect(`${FRONTEND_URL}/dashboard?payment=failed`);
    }

    const { amount, customer } = verifyData.data;
    const email = (customer?.email || "").toLowerCase();

    let user = await User.findOne({ email });
    if (!user) {
      user = new User({
        name: customer?.name || "HIGHTECH User",
        email,
        password: "", verified: true, balance: 0,
        referralEarnings: 0,
        referralCode: (email.split("@")[0] + Math.floor(Math.random() * 9000)).toUpperCase()
      });
      await user.save();
    }

    // credit balance
    user.balance = (user.balance || 0) + Number(amount);

    // referral bonus
    if (user.referredBy) {
      const referrer = await User.findOne({ referralCode: user.referredBy });
      if (referrer) {
        const bonus = Math.round(Number(amount) * 0.10);
        referrer.referralEarnings = (referrer.referralEarnings || 0) + bonus;
        await referrer.save();
        console.log(`🎉 Referral bonus ${bonus} credited to ${referrer.email}`);
      }
    }
    await user.save();

    // record deposit & promo
    const promo = await Promo.findOne();
    let promoApplied = false;
    if (promo && promo.used < promo.limit) {
      promo.used += 1;
      await promo.save();
      promoApplied = true;
    }

    const dep = new Deposit({
      userId: user._id,
      email,
      amount: Number(amount),
      txId: transaction_id,
      txRef: tx_ref || null,
      status: "successful",
      promoApplied
    });
    await dep.save();

    return res.redirect(`${FRONTEND_URL}/dashboard?payment=success`);
  } catch (err) {
    console.error("callback err", err);
    return res.redirect(`${FRONTEND_URL}/dashboard?payment=error`);
  }
});

/* Minimal admin endpoints for listing */
app.get("/api/admin/users", async (req,res) => {
  const list = await User.find().select("name email balance referralEarnings createdAt");
  res.json({ success:true, users: list });
});
app.get("/api/admin/deposits", async (req,res) => {
  const list = await Deposit.find().sort({ createdAt:-1 }).limit(200);
  res.json({ success:true, deposits: list });
});

/* Start */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 HIGHTECH backend listening on ${PORT}`));
