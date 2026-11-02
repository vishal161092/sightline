/**
 * de_AutoFeatureServiceTest
 * Coverage for the vehicle video-feature service layer:
 *   - de_AutoProductService.getCars (scoped to the 'Auto POC' family)
 *   - de_AutoLeadService (invocable + LWC entry points, no callout)
 *   - de_AutoFeatureGrounding blank-input guard
 *   - de_AutoAgentforceService start/send via an HttpCalloutMock
 */
@IsTest
private class de_AutoFeatureServiceTest {

    @TestSetup
    static void seed() {
        insert new Product2(
            Name = 'Test EV Model X',
            ProductCode = 'DE-TEST-EV',
            Family = 'Auto POC',
            IsActive = true,
            Description = 'Test electric vehicle with a 15-inch touchscreen, dual-motor AWD, and 19-inch alloy wheels.'
        );
    }

    @IsTest
    static void testGetCars() {
        Test.startTest();
        List<de_AutoProductService.CarDTO> cars = de_AutoProductService.getCars();
        Test.stopTest();
        System.assertEquals(1, cars.size(), 'Should return the one seeded Auto POC car');
        System.assertEquals('Test EV Model X', cars[0].name);
    }

    @IsTest
    static void testCreateLead() {
        Test.startTest();
        de_AutoLeadService.LeadResult r =
            de_AutoLeadService.createLead('Test EV Model X', 'Wants a test drive', 'Jordan', 'Chatted about range.');
        Test.stopTest();
        System.assertEquals(true, r.success, 'Lead should be created');
        System.assertNotEquals(null, r.leadId, 'Lead Id should be returned');
        System.assertEquals(1, [SELECT COUNT() FROM Lead WHERE Id = :r.leadId]);
    }

    @IsTest
    static void testLogLeadInvocable() {
        de_AutoLeadService.Request req = new de_AutoLeadService.Request();
        req.carName = 'Test EV Model X';
        req.interestSummary = 'Interested in the tech package';
        Test.startTest();
        List<de_AutoLeadService.Response> resps =
            de_AutoLeadService.logLead(new List<de_AutoLeadService.Request>{ req });
        Test.stopTest();
        System.assertEquals(1, resps.size());
        System.assertNotEquals(null, resps[0].leadId);
    }

    @IsTest
    static void testGroundingBlankGuard() {
        Test.startTest();
        String guide = de_AutoFeatureGrounding.generateGuide('', 'wheels');
        Test.stopTest();
        System.assertEquals('', guide, 'Blank car name returns empty guide without a callout');
    }

    @IsTest
    static void testGroundingFallsBackToSeededSpec() {
        // ConnectApi prompt-template generation isn't available in test context, so the
        // grounding class degrades gracefully to the seeded Product2 spec. Exercise both
        // the exact-name lookup and the loose (partial-name) match.
        Test.startTest();
        String exact = de_AutoFeatureGrounding.generateGuideForCar('Test EV Model X', 'touchscreen');
        String loose = de_AutoFeatureGrounding.generateGuideForCar('Test EV', '');
        Test.stopTest();
        System.assert(exact.contains('touchscreen'), 'Exact match should fall back to the seeded spec');
        System.assert(loose.contains('touchscreen'), 'Loose match should also fall back to the seeded spec');
    }

    @IsTest
    static void testVisionAnalyzeFrame() {
        Test.setMock(HttpCalloutMock.class, new VertexMock());
        Test.startTest();
        de_VideoReasoningController.VisionResult r =
            de_VideoReasoningController.analyzeFrame('aGVsbG8=', 'image/jpeg', 'Describe the car.');
        de_VideoReasoningController.VisionResult r2 =
            de_VideoReasoningController.analyzeFrameWithModel('aGVsbG8=', 'image/jpeg', 'Detect the wheels.', 'gemini-2.5-flash');
        Test.stopTest();
        System.assertEquals(true, r.success, 'Vision call should succeed against the mock');
        System.assertEquals('A blue electric SUV with alloy wheels.', r.text);
        System.assertEquals(true, r2.success);
    }

    @IsTest
    static void testAgentforceStartSession() {
        // The service reads its config from the de_Sightline_Config.Auto_Agent custom metadata
        // record deployed with this project (REPLACE_ME placeholders are fine: callouts are mocked).
        Test.setMock(HttpCalloutMock.class, new AgentApiMock());
        Test.startTest();
        de_AutoAgentforceService.AgentReply reply = de_AutoAgentforceService.startSession('Test EV Model X');
        Test.stopTest();
        System.assertEquals(true, reply.success, 'Session should start against the mock');
        System.assertEquals('sess-123', reply.sessionId);
    }

    /** Mock for the Google OAuth token exchange + the Vertex generateContent call. */
    private class VertexMock implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest req) {
            HttpResponse res = new HttpResponse();
            res.setHeader('Content-Type', 'application/json');
            res.setStatusCode(200);
            String url = req.getEndpoint();
            if (url.contains('oauth2.googleapis.com/token')) {
                res.setBody('{"access_token":"ya29.mock","token_type":"Bearer","expires_in":3600}');
            } else if (url.contains('aiplatform.googleapis.com')) {
                res.setBody(
                    '{"candidates":[{"content":{"parts":[{"text":"A blue electric SUV with alloy wheels."}]}}]}'
                );
            } else {
                res.setBody('{}');
            }
            return res;
        }
    }

    /** Minimal mock for the OAuth token, session-create, and message endpoints. */
    private class AgentApiMock implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest req) {
            HttpResponse res = new HttpResponse();
            res.setHeader('Content-Type', 'application/json');
            res.setStatusCode(200);
            String url = req.getEndpoint();
            if (url.contains('/services/oauth2/token')) {
                res.setBody('{"access_token":"tok","token_type":"Bearer"}');
            } else if (url.contains('/sessions/')) {
                // send-message endpoint
                res.setBody('{"messages":[{"message":"Hi! Here are the features of your car."}]}');
            } else if (url.endsWith('/sessions')) {
                res.setBody('{"sessionId":"sess-123"}');
            } else {
                res.setBody('{}');
            }
            return res;
        }
    }
}
