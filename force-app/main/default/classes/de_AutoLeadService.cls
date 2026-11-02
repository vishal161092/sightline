/**
 * de_AutoLeadService
 * Logs a sales Lead for the Auto Feature experience and returns a short reference, so a
 * prospective buyer who asks to "book a test drive" or "talk to a sales specialist" is
 * captured for follow-up. Used two ways:
 *   1. As an Agentforce action (@InvocableMethod) so the agent can log the lead + hand off.
 *   2. @AuraEnabled so the LWC can log the lead directly when it detects the intent,
 *      guaranteeing capture even if the agent phrasing varies.
 *
 * The Lead is created server-side (agent / integration context) rather than by the LWR guest
 * user, because guest users cannot own records. Runs `without sharing` so the insert isn't
 * blocked by org-wide defaults.
 */
public without sharing class de_AutoLeadService {

    private static final String LEAD_COMPANY = 'Sightline Vehicle Video Lead';

    // ---- Invocable wiring (Agentforce action) ----
    public class Request {
        @InvocableVariable(label='Car Name' description='The car the prospect is interested in.' required=true)
        public String carName;

        @InvocableVariable(label='Interest Summary' description='Short summary of what the prospect is interested in or asked to do (e.g. "wants a test drive of the Long Range trim").')
        public String interestSummary;

        @InvocableVariable(label='Contact Name' description='The prospect name, if given.')
        public String contactName;

        @InvocableVariable(label='Conversation Summary' description='Optional longer summary of the conversation so far.')
        public String conversationSummary;
    }

    public class Response {
        @InvocableVariable(label='Lead Reference' description='A short reference to tell the prospect (the created Lead record Id).')
        public String leadRef;

        @InvocableVariable(label='Lead Id' description='The Salesforce record Id of the created Lead.')
        public String leadId;
    }

    @InvocableMethod(label='Log Sales Lead' description='Creates a sales Lead for the prospect and returns a reference, so the conversation can be handed off to a human sales specialist.')
    public static List<Response> logLead(List<Request> requests) {
        List<Response> out = new List<Response>();
        for (Request r : requests) {
            LeadResult lr = createLeadInternal(r.carName, r.interestSummary, r.contactName, r.conversationSummary);
            Response resp = new Response();
            resp.leadRef = lr.leadId;
            resp.leadId = lr.leadId;
            out.add(resp);
        }
        return out;
    }

    // ---- LWC entry point ----
    @AuraEnabled
    public static LeadResult createLead(String carName, String interestSummary, String contactName, String conversationSummary) {
        return createLeadInternal(carName, interestSummary, contactName, conversationSummary);
    }

    public class LeadResult {
        @AuraEnabled public String leadRef;
        @AuraEnabled public String leadId;
        @AuraEnabled public Boolean success;
        @AuraEnabled public String error;
    }

    // ---- Core ----
    private static LeadResult createLeadInternal(String carName, String interestSummary, String contactName, String conversationSummary) {
        LeadResult result = new LeadResult();
        try {
            String car = String.isBlank(carName) ? 'Unknown vehicle' : carName.trim();
            String interest = String.isBlank(interestSummary)
                ? 'Prospect asked to speak with a sales specialist.'
                : interestSummary.trim();
            String lastName = String.isBlank(contactName) ? 'Prospect' : contactName.trim();

            Lead ld = new Lead();
            ld.LastName = lastName.abbreviate(80);
            ld.Company = LEAD_COMPANY;
            ld.LeadSource = 'Web';
            ld.Status = 'Open - Not Contacted';
            ld.Description = 'Vehicle of interest: ' + car + '\n'
                + 'Interest: ' + interest + '\n\n'
                + 'Conversation summary:\n'
                + (String.isBlank(conversationSummary) ? '(none provided)' : conversationSummary);

            insert ld;

            result.leadRef = ld.Id;
            result.leadId = ld.Id;
            result.success = true;
        } catch (Exception e) {
            result.success = false;
            result.error = e.getMessage();
        }
        return result;
    }
}
