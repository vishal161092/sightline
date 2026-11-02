// Smoke test: start a troubleshooting agent session and send one turn.
// Requires the de_Sightline_Config.Troubleshooting_Agent record to be filled in.
de_AgentforceService.AgentReply s = de_AgentforceService.startSession('Velo Induction Cooktop IC 3.0');
System.debug('START_OK: ' + s.success + ' SESSION=' + s.sessionId + ' SEQ=' + s.nextSequenceId + ' ERR=' + s.error);
System.debug('REPLY: ' + s.text);
de_AgentforceService.AgentReply r = de_AgentforceService.sendMessage(s.sessionId, s.nextSequenceId,
    'The user said: "It shows an E0 error, what do I do?". What the live camera currently shows: the induction cooktop display panel.');
System.debug('TURN_OK: ' + r.success + ' ERR=' + r.error);
System.debug('TURN_REPLY: ' + r.text);
