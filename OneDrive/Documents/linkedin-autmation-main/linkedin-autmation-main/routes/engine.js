const express = require('express');
const router = express.Router();
const { auth, adminAuth } = require('../middleware/auth');
const engine = require('../services/automationEngine');

// GET /api/engine/status
router.get('/status', auth, async (req, res) => {
  res.json(engine.status());
});

// POST /api/engine/start
router.post('/start', adminAuth, async (req, res) => {
  engine.start();
  res.json({ ok: true, status: engine.status() });
});

// POST /api/engine/stop
router.post('/stop', adminAuth, async (req, res) => {
  engine.stop();
  res.json({ ok: true, status: engine.status() });
});

module.exports = router;


