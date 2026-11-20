"""AI phone calls (SaaS phase 4, voice channel).

The pieces, from the phone line inwards:

  twilio_stream.py  Twilio Media Streams messages (the call's audio, mu-law 8 kHz)
  providers.py      what the engine needs from a speech-to-text / text-to-speech vendor
  elevenlabs.py     ElevenLabs behind those interfaces (streaming, mu-law 8 kHz both ways)
  session.py        one call: listen, think, speak, handle interruptions, end
  brain.py          the conversation model (streaming) and what it is told
  phrases.py        the few fixed sentences (AI disclosure, goodbye, opt-out) per language
  gate.py           may this call be placed right now? (consent, suppression, hours)
  server.py         the HTTP / WebSocket server Twilio talks to, and the dialer

The vendors are swappable per language: nothing outside elevenlabs.py knows
ElevenLabs exists, so a model we train ourselves on recorded, consented human
speech can replace it for any language it beats ElevenLabs in a blind listening
test. ElevenLabs output is never used to train anything (their use policy,
section 12, forbids it).
"""
