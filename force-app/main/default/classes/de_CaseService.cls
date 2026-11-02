/**
 * de_CaseService
 * Logs a support Case for the Video Troubleshooting experience and returns the human-readable
 * case number. Used two ways:
 *   1. As an Agentforce action (@InvocableMethod) so the agent can log a case + escalate when the
 *      user says "create a case/ticket" or "I want to talk to an expert".
 *   2. @AuraEnabled so the LWC can log the case directly when it detects an escalation intent,
 *      guaranteeing the customer gets a case number even if the agent phrasing varies.
 *
 * The Case is created server-side (agent / integration context) rather than by the LWR guest user,
 * because guest users cannot own records. Runs `without sharing` so the insert isn't blocked by
 * org-wide defaults.
 */
public without sharing class de_CaseService {

    // ---- Invocable wiring (Agentforce action) ----
    public class Request {
        @InvocableVariable(label='Product Name' description='The product the customer is troubleshooting.' required=true)
        public String productName;

        @InvocableVariable(label='Issue Summary' description='Short summary of the problem the customer is facing, in their words.')
        public String issueSummary;

        @InvocableVariable(label='Conversation Summary' description='Optional longer summary / transcript of the troubleshooting conversation so far.')
        public String conversationSummary;
    }

    public class Response {
        @InvocableVariable(label='Case Number' description='The human-readable case number to tell the customer.')
        public String caseNumber;

        @InvocableVariable(label='Case Id' description='The Salesforce record Id of the created case.')
        public String caseId;
    }

    @InvocableMethod(label='Log Support Case' description='Creates a support Case for the customer and returns the case number, so the conversation can be escalated to a human specialist.')
    public static List<Response> logCase(List<Request> requests) {
        List<Response> out = new List<Response>();
        for (Request r : requests) {
            CaseResult cr = createCaseInternal(r.productName, r.issueSummary, r.conversationSummary);
            Response resp = new Response();
            resp.caseNumber = cr.caseNumber;
            resp.caseId = cr.caseId;
            out.add(resp);
        }
        return out;
    }

    // ---- LWC entry point ----
    @AuraEnabled
    public static CaseResult createCase(String productName, String issueSummary, String conversationSummary) {
        return createCaseInternal(productName, issueSummary, conversationSummary);
    }

    public class CaseResult {
        @AuraEnabled public String caseNumber;
        @AuraEnabled public String caseId;
        @AuraEnabled public Boolean success;
        @AuraEnabled public String error;
    }

    // ---- Core ----
    private static CaseResult createCaseInternal(String productName, String issueSummary, String conversationSummary) {
        CaseResult result = new CaseResult();
        try {
            String prod = String.isBlank(productName) ? 'Unknown product' : productName.trim();
            String issue = String.isBlank(issueSummary) ? 'Customer requested help from a specialist.' : issueSummary.trim();

            Case c = new Case();
            c.Subject = 'Video Troubleshooting: ' + prod + ' — ' + issue.abbreviate(200);
            c.Description = 'Product: ' + prod + '\n'
                + 'Reported issue: ' + issue + '\n\n'
                + 'Conversation summary:\n'
                + (String.isBlank(conversationSummary) ? '(none provided)' : conversationSummary);
            c.Status = 'New';
            c.Origin = 'Web'; // standard picklist value; safe against restricted Origin lists
            c.Priority = 'Medium';

            insert c;

            Case created = [SELECT Id, CaseNumber FROM Case WHERE Id = :c.Id LIMIT 1];
            result.caseNumber = created.CaseNumber;
            result.caseId = created.Id;
            result.success = true;
        } catch (Exception e) {
            result.success = false;
            result.error = e.getMessage();
        }
        return result;
    }
}
