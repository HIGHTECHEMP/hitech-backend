import mongoose from "mongoose";

const depositSchema = new mongoose.Schema({
  userId: String,
  email: String,
  amount: Number,
  txId: String,
  txRef: String,
  status: String,
  promoApplied: Boolean,
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model("Deposit", depositSchema);
