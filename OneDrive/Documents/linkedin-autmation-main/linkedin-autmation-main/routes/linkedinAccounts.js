const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { auth } = require('../middleware/auth');
const LinkedInAccount = require('../models/LinkedInAccount');

// GET /api/linkedin-accounts
router.get('/', auth, async (req, res) => {
  try {
    const accounts = await LinkedInAccount.find({ createdBy: req.user.id }).sort({ createdAt: -1 });
    res.json(accounts);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// POST /api/linkedin-accounts
router.post('/', [
  auth,
  body('label', 'Label is required').not().isEmpty()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    const account = new LinkedInAccount({
      createdBy: req.user.id,
      label: req.body.label,
      loginEmail: req.body.loginEmail,
      sessionCookies: req.body.sessionCookies,
      notes: req.body.notes
    });
    await account.save();
    res.json(account);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// PUT /api/linkedin-accounts/:id
router.put('/:id', auth, async (req, res) => {
  try {
    const account = await LinkedInAccount.findOne({ _id: req.params.id, createdBy: req.user.id });
    if (!account) return res.status(404).json({ msg: 'Account not found' });

    account.label = req.body.label ?? account.label;
    account.loginEmail = req.body.loginEmail ?? account.loginEmail;
    account.sessionCookies = req.body.sessionCookies ?? account.sessionCookies;
    account.isActive = typeof req.body.isActive === 'boolean' ? req.body.isActive : account.isActive;
    account.notes = req.body.notes ?? account.notes;
    await account.save();
    res.json(account);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

// DELETE /api/linkedin-accounts/:id
router.delete('/:id', auth, async (req, res) => {
  try {
    const account = await LinkedInAccount.findOne({ _id: req.params.id, createdBy: req.user.id });
    if (!account) return res.status(404).json({ msg: 'Account not found' });
    await account.remove();
    res.json({ msg: 'Account removed' });
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

module.exports = router;


