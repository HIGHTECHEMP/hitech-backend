import mongoose from "mongoose";

const promoSchema = new mongoose.Schema({
  name: String,
  limit: Number,
  used: { type: Number, default: 0 },
});

export default mongoose.model("Promo", promoSchema);
