/**
 * de_TroubleshootingGrounding
 * Agent-callable grounding action for the Video Troubleshooting Agent. Given a product name
 * (and, optionally, the specific issue/error the user reported), it invokes the Prompt Builder
 * flex template 'Product_Troubleshooting_Video' (managed model, Claude Opus) to produce a
 * comprehensive troubleshooting guide. The agent grounds the rest of the conversation on the
 * returned text. Also exposed @AuraEnabled for direct testing from the LWC / anon Apex.
 */
public with sharing class de_TroubleshootingGrounding {

    // Prompt Builder flex template (dev name) + its two input reference names.
    private static final String TEMPLATE_API_NAME = 'Product_Troubleshooting_Video';
    private static final String INPUT_PRODUCT_NAME = 'Input:productName';
    private static final String INPUT_PRODUCT_ISSUE = 'Input:productIssue';

    // ---- Invocable wiring (so the Agentforce agent can call it as an action) ----
    public class Request {
        @InvocableVariable(label='Product Name' description='Name of the product to generate a troubleshooting guide for.' required=true)
        public String productName;

        @InvocableVariable(label='Product Issue' description='The specific problem, symptom, or error code the user reported or that is visible, if any. Leave blank if unknown.')
        public String productIssue;
    }

    public class Response {
        @InvocableVariable(label='Troubleshooting Guide' description='Structured troubleshooting guide the agent should ground on.')
        public String guide;
    }

    @InvocableMethod(label='Get Troubleshooting Guide' description='Generates a prompt-template-grounded troubleshooting guide for a product, for the agent to ground its conversation on.')
    public static List<Response> getGuide(List<Request> requests) {
        List<Response> out = new List<Response>();
        for (Request r : requests) {
            Response resp = new Response();
            resp.guide = generateGuide(r.productName, r.productIssue);
            out.add(resp);
        }
        return out;
    }

    @AuraEnabled
    public static String generateGuideForProduct(String productName, String productIssue) {
        return generateGuide(productName, productIssue);
    }

    // ---- Core: invoke the Prompt Builder flex template ----
    public static String generateGuide(String productName, String productIssue) {
        if (String.isBlank(productName)) {
            return '';
        }

        ConnectApi.EinsteinPromptTemplateGenerationsInput genInput =
            new ConnectApi.EinsteinPromptTemplateGenerationsInput();

        Map<String, ConnectApi.WrappedValue> inputParams = new Map<String, ConnectApi.WrappedValue>();

        ConnectApi.WrappedValue nameVal = new ConnectApi.WrappedValue();
        nameVal.value = productName;
        inputParams.put(INPUT_PRODUCT_NAME, nameVal);

        ConnectApi.WrappedValue issueVal = new ConnectApi.WrappedValue();
        issueVal.value = String.isBlank(productIssue) ? '' : productIssue;
        inputParams.put(INPUT_PRODUCT_ISSUE, issueVal);

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
            return 'Unable to generate guide (empty response from prompt template).';
        } catch (Exception e) {
            return 'Unable to generate guide: ' + e.getMessage();
        }
    }
}
