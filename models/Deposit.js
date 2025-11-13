import mongoose from "mongoose";

const DepositSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  email: { type: String, required: true },
  amount: { type: Number, required: true },
  txRef: { type: String, required: true, unique: true },
  status: { type: String, default: "pending" }, // pending | successful | failed
  gatewayResponse: { type: String },
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model("Deposit", DepositSchema);
