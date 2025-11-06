import mongoose from 'mongoose';
import bcrypt from 'bcrypt';

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: 3,
    maxlength: 15
  },
  password: {
    type: String,
    required: true,
    minlength: 3
  },
  totalKills: {
    type: Number,
    default: 0
  },
  totalScore: {
    type: Number,
    default: 0
  },
  bestStreak: {
    type: Number,
    default: 0
  },
  totalDeaths: {
    type: Number,
    default: 0
  },
  rankPoints: {
    type: Number,
    default: 0
  },
  rankLabel: {
    type: String,
    default: 'Demir 1'
  },
  highestRankLabel: {
    type: String,
    default: 'Demir 1'
  },
  highestRankPoints: {
    type: Number,
    default: 0
  },
  level: {
    type: Number,
    default: 1
  },
  xp: {
    type: Number,
    default: 0
  },
  credits: {
    type: Number,
    default: 0
  },
  skills: {
    speedBoost: { type: Number, default: 0 },
    shield: { type: Number, default: 0 },
    rapidFire: { type: Number, default: 0 }
  },
  weapons: {
    cannon: { type: Number, default: 1 },
    torpedo: { type: Number, default: 0 },
    missile: { type: Number, default: 0 }
  },
  normalMatches: {
    type: Number,
    default: 0
  },
  shipColor: {
    type: String,
    default: '#ffffff'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastLogin: {
    type: Date,
    default: Date.now
  }
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

// Method to compare password
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

export default mongoose.model('User', userSchema);

