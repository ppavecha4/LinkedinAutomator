const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const Notification = require('../models/Notification');

// GET /api/notifications
router.get('/', auth, async (req, res) => {
  const list = await Notification.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(100);
  res.json(list);
});

// POST /api/notifications/:id/read
router.post('/:id/read', auth, async (req, res) => {
  const n = await Notification.findOne({ _id: req.params.id, user: req.user._id });
  if (!n) return res.status(404).json({ msg: 'Not found' });
  n.read = true;
  await n.save();
  res.json({ ok: true });
});

module.exports = router;


