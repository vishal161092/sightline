/**
 * de_VideoReasoningController
 * Same-origin Apex proxy for the video-reasoning flow. The (guest) browser sends a captured
 * camera frame + a text prompt; Apex holds the Google credential server-side (via
 * de_GoogleAuthService) and calls Vertex `gemini-2.5-flash-image:generateContent` to reason
 * about the frame, returning plain-text guidance. Keeps all secrets off the client.
 */
public with sharing class de_VideoReasoningController {

    private static final String LOCATION = 'us-central1';
    private static final String DEFAULT_MODEL = 'gemini-2.5-flash-image';

    public class VisionResult {
        @AuraEnabled public String text;
        @AuraEnabled public Boolean success;
        @AuraEnabled public String error;
    }

    /**
     * Analyze a single camera frame.
     * @param base64Image  raw base64 (no data-URI prefix) of a JPEG/PNG frame; may be blank for text-only turns
     * @param mimeType     e.g. 'image/jpeg' (defaults to image/jpeg when a frame is supplied)
     * @param prompt       the instruction / question for the model
     */
    @AuraEnabled
    public static VisionResult analyzeFrame(String base64Image, String mimeType, String prompt) {
        return analyzeFrameWithModel(base64Image, mimeType, prompt, null);
    }

    /**
     * As analyzeFrame, but lets the caller pick the Gemini model. Object localization
     * ("mark where X is") is far more accurate on `gemini-2.5-flash` than on the
     * image-generation model, so the marker flow passes that model explicitly.
     * @param model  Vertex model name; blank/null falls back to DEFAULT_MODEL.
     */
    @AuraEnabled
    public static VisionResult analyzeFrameWithModel(String base64Image, String mimeType, String prompt, String model) {
        VisionResult result = new VisionResult();
        try {
            String token = de_GoogleAuthService.getAccessToken();
            String projectId = de_GoogleAuthService.getProjectId();
            String useModel = String.isBlank(model) ? DEFAULT_MODEL : model;
            String endpoint = 'https://' + LOCATION + '-aiplatform.googleapis.com/v1/projects/'
                + projectId + '/locations/' + LOCATION + '/publishers/google/models/'
                + useModel + ':generateContent';

            // Build request body: text part + optional inline image part.
            JSONGenerator gen = JSON.createGenerator(false);
            gen.writeStartObject();
                gen.writeFieldName('contents');
                gen.writeStartArray();
                    gen.writeStartObject();
                        gen.writeStringField('role', 'user');
                        gen.writeFieldName('parts');
                        gen.writeStartArray();
                            gen.writeStartObject();
                                gen.writeStringField('text', String.isBlank(prompt) ? 'Describe what you see.' : prompt);
                            gen.writeEndObject();
                            if (String.isNotBlank(base64Image)) {
                                gen.writeStartObject();
                                    gen.writeFieldName('inlineData');
                                    gen.writeStartObject();
                                        gen.writeStringField('mimeType', String.isBlank(mimeType) ? 'image/jpeg' : mimeType);
                                        gen.writeStringField('data', base64Image);
                                    gen.writeEndObject();
                                gen.writeEndObject();
                            }
                        gen.writeEndArray();
                    gen.writeEndObject();
                gen.writeEndArray();
                // NOTE: gemini-2.5-flash-image rejects an explicit responseModalities of TEXT
                // ("request is not supported by this model"). Omit generationConfig — the model
                // returns text for a text-style prompt; extractText() ignores any image parts.
            gen.writeEndObject();

            HttpRequest req = new HttpRequest();
            req.setEndpoint(endpoint);
            req.setMethod('POST');
            req.setHeader('Authorization', 'Bearer ' + token);
            req.setHeader('Content-Type', 'application/json');
            req.setTimeout(120000);
            req.setBody(gen.getAsString());

            HttpResponse res = new Http().send(req);
            if (res.getStatusCode() != 200) {
                result.success = false;
                result.error = 'Vertex HTTP ' + res.getStatusCode() + ': ' + res.getBody();
                return result;
            }

            result.text = extractText(res.getBody());
            result.success = true;
            return result;
        } catch (Exception e) {
            result.success = false;
            result.error = e.getMessage();
            return result;
        }
    }

    /** Concatenate all text parts of candidates[0]. */
    private static String extractText(String body) {
        Map<String, Object> parsed = (Map<String, Object>) JSON.deserializeUntyped(body);
        List<Object> candidates = (List<Object>) parsed.get('candidates');
        if (candidates == null || candidates.isEmpty()) {
            return '';
        }
        Map<String, Object> first = (Map<String, Object>) candidates[0];
        Map<String, Object> content = (Map<String, Object>) first.get('content');
        if (content == null) {
            return '';
        }
        List<Object> parts = (List<Object>) content.get('parts');
        if (parts == null) {
            return '';
        }
        String out = '';
        for (Object p : parts) {
            Map<String, Object> part = (Map<String, Object>) p;
            if (part.get('text') != null) {
                out += (String) part.get('text');
            }
        }
        return out;
    }
}
