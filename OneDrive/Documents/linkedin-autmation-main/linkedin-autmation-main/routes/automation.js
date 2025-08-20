const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { auth } = require('../middleware/auth');
const Automation = require('../models/Automation');
const LinkedInAccount = require('../models/LinkedInAccount');
const Activity = require('../models/Activity');



// @route   GET /api/automation
// @desc    Get all automations for user
// @access  Private
router.get('/', auth, async (req, res) => {
  try {
    const automations = await Automation.find({ createdBy: req.user.id })
      .populate('templates', 'name')
      .populate('account', 'label loginEmail')
      .sort({ createdAt: -1 });
    res.json(automations);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET /api/automation/:id
// @desc    Get automation by ID
// @access  Private
router.get('/:id', auth, async (req, res) => {
  try {
    const automation = await Automation.findOne({
      _id: req.params.id,
      createdBy: req.user.id
    }).populate('templates', 'name').populate('account', 'label loginEmail');

    if (!automation) {
      return res.status(404).json({ msg: 'Automation not found' });
    }

    res.json(automation);
  } catch (err) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Automation not found' });
    }
    res.status(500).send('Server Error');
  }
});

// @route   POST /api/automation
// @desc    Create new automation
// @access  Private
router.post('/', [
  auth,
  body('name', 'Name is required').not().isEmpty(),
  body('type', 'Type is required').isIn(['connection_request', 'message_send', 'follow_up', 'campaign']),
  body('account', 'LinkedIn account is required').not().isEmpty()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const {
    name,
    description,
    type,
    searchCriteria,
    schedule,
    limits,
    templates,
    channels
  } = req.body;

  try {
    // Optional: validate account belongs to user when provided
    if (req.body.account) {
      const account = await LinkedInAccount.findOne({ _id: req.body.account, createdBy: req.user.id });
      if (!account) {
        return res.status(400).json({ msg: 'Invalid LinkedIn account' });
      }
    }

    const newAutomation = new Automation({
      createdBy: req.user.id,
      name,
      description,
      type,
      searchCriteria,
      schedule,
      limits,
      templates,
      channels,
      account: req.body.account,
      status: 'draft'
    });

    const automation = await newAutomation.save();
    await automation.populate('templates', 'name');
    res.json(automation);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   PUT /api/automation/:id
// @desc    Update automation
// @access  Private
router.put('/:id', [
  auth,
  body('name', 'Name is required').not().isEmpty(),
  body('type', 'Type is required').isIn(['connection_request', 'message_send', 'follow_up', 'campaign']),
  body('account', 'LinkedIn account is required').not().isEmpty()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    let automation = await Automation.findOne({
      _id: req.params.id,
      createdBy: req.user.id
    });

    if (!automation) {
      return res.status(404).json({ msg: 'Automation not found' });
    }

    const {
      name,
      description,
      type,
      searchCriteria,
      schedule,
      limits,
      templates,
      channels
    } = req.body;

    automation.name = name;
    automation.description = description ?? automation.description;
    automation.type = type;
    automation.searchCriteria = searchCriteria || automation.searchCriteria;
    automation.schedule = schedule || automation.schedule;
    automation.limits = limits || automation.limits;
    automation.templates = templates || automation.templates;
    automation.channels = channels || automation.channels;
    const account = await LinkedInAccount.findOne({ _id: req.body.account, createdBy: req.user.id });
    if (!account) {
      return res.status(400).json({ msg: 'Invalid LinkedIn account' });
    }
    automation.account = req.body.account;

    await automation.save();
    await automation.populate('templates', 'name');

    res.json(automation);
  } catch (err) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Automation not found' });
    }
    res.status(500).send('Server Error');
  }
});

// @route   DELETE /api/automation/:id
// @desc    Delete automation
// @access  Private
router.delete('/:id', auth, async (req, res) => {
  try {
    const automation = await Automation.findOne({
      _id: req.params.id,
      createdBy: req.user.id
    });

    if (!automation) {
      return res.status(404).json({ msg: 'Automation not found' });
    }

    await automation.remove();
    res.json({ msg: 'Automation removed' });
  } catch (err) {
    console.error(err.message);
    if (err.kind === 'ObjectId') {
      return res.status(404).json({ msg: 'Automation not found' });
    }
    res.status(500).send('Server Error');
  }
});

// @route   POST /api/automation/:id/start
// @desc    Activate automation (set status to active)
// @access  Private
router.post('/:id/start', auth, async (req, res) => {
  try {
    const automation = await Automation.findOne({
      _id: req.params.id,
      createdBy: req.user.id
    });

    if (!automation) {
      return res.status(404).json({ msg: 'Automation not found' });
    }

    if (automation.status === 'active') {
      return res.status(400).json({ msg: 'Automation is already active' });
    }

    automation.status = 'active';
    await automation.save();

    res.json({ msg: 'Automation activated successfully' });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   POST /api/automation/:id/stop
// @desc    Pause automation (set status to paused)
// @access  Private
router.post('/:id/stop', auth, async (req, res) => {
  try {
    const automation = await Automation.findOne({
      _id: req.params.id,
      createdBy: req.user.id
    });

    if (!automation) {
      return res.status(404).json({ msg: 'Automation not found' });
    }

    automation.status = 'paused';
    await automation.save();

    res.json({ msg: 'Automation paused successfully' });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// @route   GET /api/automation/:id/activities
// @desc    Get automation activities
// @access  Private
router.get('/:id/activities', auth, async (req, res) => {
  try {
    const activities = await Activity.find({
      automation: req.params.id,
      user: req.user.id
    }).sort({ createdAt: -1 });

    res.json(activities);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router; 