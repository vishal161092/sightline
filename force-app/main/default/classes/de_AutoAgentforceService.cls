/**
 * de_AutoAgentforceService
 * Same-origin Apex proxy to the Einstein Agent API for the vehicle video-feature flow.
 * The guest browser calls startSession()/sendMessage(); Apex holds the connected-app
 * credentials server-side (client-credentials OAuth) and relays to the Agent API.
 *
 * Config lives in the protected Custom Metadata record de_Sightline_Config.Auto_Agent
 * (Consumer_Key__c, Consumer_Secret__c, Agent_Id__c, My_Domain_Url__c, API_Base_Url__c).
 * The committed values are REPLACE_ME placeholders.
 *
 * NOTE: Agent_Id__c must be the published Auto Feature Agent's id; fill it in after
 * publishing the authoring bundle.
 */
public with sharing class de_AutoAgentforceService {

    public class AgentReply {
        @AuraEnabled public String sessionId;
        @AuraEnabled public String text;
        @AuraEnabled public Integer nextSequenceId;
        @AuraEnabled public Boolean success;
        @AuraEnabled public String error;
    }

    // ---- Public entry points (guest browser) ----

    /** Start a session for a car and return the agent's first grounded reply. */
    @AuraEnabled
    public static AgentReply startSession(String productName) {
        AgentReply out = new AgentReply();
        try {
            Map<String, Object> cfg = getConfig();
            String token = getAccessToken(cfg);

            String startEndpoint = (String) cfg.get('apiBaseUrl')
                + '/einstein/ai-agent/v1/agents/' + (String) cfg.get('agentId') + '/sessions';

            JSONGenerator gen = JSON.createGenerator(false);
            gen.writeStartObject();
                gen.writeStringField('externalSessionKey', newKey());
                gen.writeFieldName('instanceConfig');
                gen.writeStartObject();
                    gen.writeStringField('endpoint', (String) cfg.get('myDomainUrl'));
                gen.writeEndObject();
                gen.writeFieldName('streamingCapabilities');
                gen.writeStartObject();
                    gen.writeFieldName('chunkTypes');
                    gen.writeStartArray();
                        gen.writeString('Text');
                    gen.writeEndArray();
                gen.writeEndObject();
                gen.writeBooleanField('bypassUser', true);
            gen.writeEndObject();

            HttpResponse res = post(startEndpoint, token, gen.getAsString());
            if (res.getStatusCode() != 200 && res.getStatusCode() != 201) {
                out.success = false;
                out.error = 'Start session HTTP ' + res.getStatusCode() + ': ' + res.getBody();
                return out;
            }
            Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
            out.sessionId = (String) body.get('sessionId');

            // Seed the conversation. The experience is model-agnostic: the user points
            // a live camera at ANY Velo Motors vehicle and the agent identifies + explains
            // it from the vision context supplied each turn — so when no specific model
            // is passed we prime a generic, camera-first greeting. (A specific product,
            // if ever passed, still grounds on that car's guide.)
            String seed;
            if (String.isBlank(productName)) {
                seed = 'I\'m about to point my live camera at a Velo Motors vehicle to explore its features.'
                    + ' Greet me in one short, friendly sentence that invites me to ask about anything I see.'
                    + ' With each of my questions you\'ll get a live description of what the camera sees —'
                    + ' use that to identify the model and answer. Do not assume a specific model yet, and'
                    + ' do not mention fetching, loading, or looking anything up.';
            } else {
                seed = 'I\'m looking at my ' + productName
                    + '. Silently load its feature guide for your own context, then greet me in one short,'
                    + ' friendly sentence that invites me to ask what I\'d like to know about the car.'
                    + ' Do not mention fetching, loading, or looking anything up.';
            }
            AgentReply seeded = sendMessage(out.sessionId, 1, seed);
            out.text = seeded.success ? seeded.text : extractMessages(res.getBody());
            out.nextSequenceId = seeded.success ? seeded.nextSequenceId : 2;
            out.success = true;
            return out;
        } catch (Exception e) {
            out.success = false;
            out.error = e.getMessage();
            return out;
        }
    }

    /** Send a user turn and return the agent's reply. */
    @AuraEnabled
    public static AgentReply sendMessage(String sessionId, Integer sequenceId, String text) {
        AgentReply out = new AgentReply();
        try {
            Map<String, Object> cfg = getConfig();
            String token = getAccessToken(cfg);
            String endpoint = (String) cfg.get('apiBaseUrl')
                + '/einstein/ai-agent/v1/sessions/' + sessionId + '/messages';

            JSONGenerator gen = JSON.createGenerator(false);
            gen.writeStartObject();
                gen.writeFieldName('message');
                gen.writeStartObject();
                    gen.writeNumberField('sequenceId', sequenceId);
                    gen.writeStringField('type', 'Text');
                    gen.writeStringField('text', text);
                gen.writeEndObject();
            gen.writeEndObject();

            HttpResponse res = post(endpoint, token, gen.getAsString());
            if (res.getStatusCode() != 200 && res.getStatusCode() != 201) {
                out.success = false;
                out.error = 'Send message HTTP ' + res.getStatusCode() + ': ' + res.getBody();
                return out;
            }
            out.sessionId = sessionId;
            out.text = extractMessages(res.getBody());
            out.nextSequenceId = sequenceId + 1;
            out.success = true;
            return out;
        } catch (Exception e) {
            out.success = false;
            out.error = e.getMessage();
            return out;
        }
    }

    // ---- OAuth (client credentials) ----
    private static String getAccessToken(Map<String, Object> cfg) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint((String) cfg.get('myDomainUrl') + '/services/oauth2/token');
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/x-www-form-urlencoded');
        req.setBody('grant_type=client_credentials'
            + '&client_id=' + EncodingUtil.urlEncode((String) cfg.get('consumerKey'), 'UTF-8')
            + '&client_secret=' + EncodingUtil.urlEncode((String) cfg.get('consumerSecret'), 'UTF-8'));
        HttpResponse res = new Http().send(req);
        if (res.getStatusCode() != 200) {
            throw new CalloutException('Agent API OAuth failed: ' + res.getBody());
        }
        Map<String, Object> t = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
        return (String) t.get('access_token');
    }

    // ---- helpers ----
    private static HttpResponse post(String endpoint, String token, String body) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint(endpoint);
        req.setMethod('POST');
        req.setHeader('Authorization', 'Bearer ' + token);
        req.setHeader('Content-Type', 'application/json');
        req.setTimeout(120000);
        req.setBody(body);
        return new Http().send(req);
    }

    /** Concatenate the human-readable text of all reply messages. */
    private static String extractMessages(String body) {
        Map<String, Object> parsed = (Map<String, Object>) JSON.deserializeUntyped(body);
        List<Object> messages = (List<Object>) parsed.get('messages');
        if (messages == null) {
            return '';
        }
        String outStr = '';
        for (Object m : messages) {
            Map<String, Object> msg = (Map<String, Object>) m;
            Object txt = msg.get('message');
            if (txt != null) {
                outStr += (String) txt + ' ';
            }
        }
        return outStr.trim();
    }

    /** Reads the Agent API settings from the protected Auto_Agent record of de_Sightline_Config__mdt. */
    private static Map<String, Object> getConfig() {
        de_Sightline_Config__mdt c = de_Sightline_Config__mdt.getInstance('Auto_Agent');
        if (c == null) {
            throw new CalloutException('Missing de_Sightline_Config__mdt record "Auto_Agent". See README, Configuration.');
        }
        return new Map<String, Object>{
            'consumerKey' => c.Consumer_Key__c,
            'consumerSecret' => c.Consumer_Secret__c,
            'agentId' => c.Agent_Id__c,
            'myDomainUrl' => c.My_Domain_Url__c,
            'apiBaseUrl' => c.API_Base_Url__c
        };
    }

    /** Simple unique key for externalSessionKey (no UUID builtin needed). */
    private static String newKey() {
        return EncodingUtil.convertToHex(Crypto.generateAesKey(128));
    }
}
