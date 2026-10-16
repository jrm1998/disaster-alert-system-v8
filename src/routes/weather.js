const express = require('express');
const weatherService = require('../services/weatherService');

const router = express.Router();

// Public weather conditions + derived warnings + 3-day forecast
router.get('/', async (req, res) => {
  try {
    const data = await weatherService.getWeather(req.query.refresh === '1');
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load weather data.' });
  }
});

module.exports = router;
