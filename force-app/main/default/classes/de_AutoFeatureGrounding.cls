/**
 * de_AutoFeatureGrounding
 * Agent-callable grounding action for the Auto Feature Agent. Given a car name (and,
 * optionally, the specific part/feature the user pointed the camera at), it pulls the
 * seeded Product2 feature spec for that car and invokes the Prompt Builder flex template
 * 'Car_Feature_Video' (managed model, Claude Opus) to produce a structured feature guide
 * grounded STRICTLY on that record's spec. The agent grounds the rest of the conversation
 * on the returned text. Also exposed @AuraEnabled for direct testing from the LWC / anon Apex.
 */
public without sharing class de_AutoFeatureGrounding {

    // Prompt Builder flex template (dev name) + its input reference names.
    private static final String TEMPLATE_API_NAME = 'Car_Feature_Video';
    private static final String INPUT_CAR_NAME = 'Input:carName';
    private static final String INPUT_FEATURE = 'Input:feature';
    private static final String INPUT_CAR_INFO = 'Input:carInfo';
    private static final String POC_FAMILY = 'Auto POC';

    // ---- Invocable wiring (so the Agentforce agent can call it as an action) ----
    public class Request {
        @InvocableVariable(label='Car Name' description='Name of the car (make/model) to generate a feature guide for.' required=true)
        public String carName;

        @InvocableVariable(label='Feature' description='The specific part or feature the user asked about or is pointing the camera at (e.g. "alloy wheels", "the touchscreen", "the grille"). Leave blank for a general overview.')
        public String feature;
    }

    public class Response {
        @InvocableVariable(label='Feature Guide' description='Structured car feature guide the agent should ground on.')
        public String guide;
    }

    @InvocableMethod(label='Get Car Feature Guide' description='Generates a record-grounded feature guide for a car, for the agent to ground its conversation on.')
    public static List<Response> getGuide(List<Request> requests) {
        List<Response> out = new List<Response>();
        for (Request r : requests) {
            Response resp = new Response();
            resp.guide = generateGuide(r.carName, r.feature);
            out.add(resp);
        }
        return out;
    }

    @AuraEnabled
    public static String generateGuideForCar(String carName, String feature) {
        return generateGuide(carName, feature);
    }

    // ---- Core: fetch the seeded spec, then invoke the Prompt Builder flex template ----
    public static String generateGuide(String carName, String feature) {
        if (String.isBlank(carName)) {
            return '';
        }

        // Record-grounding: pull the curated feature spec for this car from Product2.
        String carInfo = lookupCarInfo(carName);

        ConnectApi.EinsteinPromptTemplateGenerationsInput genInput =
            new ConnectApi.EinsteinPromptTemplateGenerationsInput();

        Map<String, ConnectApi.WrappedValue> inputParams = new Map<String, ConnectApi.WrappedValue>();

        ConnectApi.WrappedValue nameVal = new ConnectApi.WrappedValue();
        nameVal.value = carName;
        inputParams.put(INPUT_CAR_NAME, nameVal);

        ConnectApi.WrappedValue featureVal = new ConnectApi.WrappedValue();
        featureVal.value = String.isBlank(feature) ? '' : feature;
        inputParams.put(INPUT_FEATURE, featureVal);

        ConnectApi.WrappedValue infoVal = new ConnectApi.WrappedValue();
        infoVal.value = String.isBlank(carInfo) ? '' : carInfo;
        inputParams.put(INPUT_CAR_INFO, infoVal);

        genInput.inputParams = inputParams;
        // applicationName must be an existing registered AI application; 'PromptBuilderPreview'
        // is the built-in one available for Apex-invoked prompt-template generations.
        genInput.additionalConfig = new ConnectApi.EinsteinLlmAdditionalConfigInput();
        genInput.additionalConfig.applicationName = 'PromptBuilderPreview';
        genInput.isPreview = false;

        try {
            ConnectApi.EinsteinPromptTemplateGenerationsRepresentation gen =
                ConnectApi.EinsteinLLM.generateMessagesForPromptTemplate(TEMPLATE_API_NAME, genInput);
            if (gen != null && gen.generations != null && !gen.generations.isEmpty()) {
                return gen.generations[0].text;
            }
            // Fall back to the raw seeded spec so the agent still has something to ground on.
            return String.isBlank(carInfo)
                ? 'Unable to generate feature guide (empty response from prompt template).'
                : carInfo;
        } catch (Exception e) {
            // Prompt template unavailable — degrade gracefully to the seeded record spec.
            return String.isBlank(carInfo) ? 'Unable to generate feature guide: ' + e.getMessage() : carInfo;
        }
    }

    /** Pull the curated feature spec (Product2.Description) for the named car in the POC set. */
    private static String lookupCarInfo(String carName) {
        List<Product2> matches = [
            SELECT Name, Description
            FROM Product2
            WHERE Family = :POC_FAMILY AND IsActive = true AND Name = :carName
            LIMIT 1
        ];
        if (!matches.isEmpty() && String.isNotBlank(matches[0].Description)) {
            return matches[0].Description;
        }
        // Loose match: the agent may pass a slightly different label than the record Name.
        for (Product2 p : [
            SELECT Name, Description FROM Product2 WHERE Family = :POC_FAMILY AND IsActive = true
        ]) {
            if (String.isNotBlank(p.Description)
                && (carName.containsIgnoreCase(p.Name) || p.Name.containsIgnoreCase(carName))) {
                return p.Description;
            }
        }
        return '';
    }
}
