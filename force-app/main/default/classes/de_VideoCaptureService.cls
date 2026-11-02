/**
 * de_VideoCaptureService
 * Saves a camera frame captured in the guest browser as a Salesforce File and
 * mints a public link for it, so the customer can share the photo with a live
 * MIAW specialist.
 *
 * Why not send the image straight into the MIAW conversation? The MIAW channel
 * has inbound file attachments disabled — the SCRT2 `/conversation/{id}/file`
 * endpoint returns 415 "Unsupported file content type" for every file type — so
 * the customer's photo can't ride the conversation. Instead we persist it here
 * and the LWC posts the returned link to the specialist as a normal text
 * message, which the specialist clicks to view the photo.
 *
 * Guest constraints handled:
 *  - Guest users have no private library, so the File must publish to a shared
 *    library (FirstPublishLocationId). The site guest user is a member of the
 *    'Video Support Captures' library with an Author (add-content) permission.
 *  - Guest object create on ContentVersion / ContentDistribution is granted via
 *    the de_VideoReasoning_Access permission set.
 *  - `with sharing` is REQUIRED: the right to publish into the library is a
 *    sharing-based grant (library membership); `without sharing` discards it and
 *    the publish fails with INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY.
 */
public with sharing class de_VideoCaptureService {

    // Shared library the guest user can publish into (see class header). A normal
    // Files library — NOT a CMS asset library, which rejects direct file publishes.
    private static final String LIBRARY_NAME = 'Video Support Captures';

    public class CaptureResult {
        @AuraEnabled public Boolean success;
        @AuraEnabled public String url;      // viewable link to send to the specialist
        @AuraEnabled public String error;
    }

    /**
     * Persist a base64 image as a File and return a viewable URL.
     * @param base64Image  raw base64 (no data: prefix)
     * @param fileName     display name, e.g. 'customer-photo.jpg'
     */
    @AuraEnabled
    public static CaptureResult savePublicImage(String base64Image, String fileName) {
        CaptureResult out = new CaptureResult();
        try {
            if (String.isBlank(base64Image)) {
                out.success = false;
                out.error = 'No image data.';
                return out;
            }
            String name = String.isBlank(fileName) ? 'customer-photo.jpg' : fileName;

            ContentVersion cv = new ContentVersion();
            cv.Title = name;
            cv.PathOnClient = name;
            cv.VersionData = EncodingUtil.base64Decode(base64Image);
            // Guests have no personal library — publish into a shared one.
            Id libId = libraryId();
            if (libId != null) {
                cv.FirstPublishLocationId = libId;
            }
            insert cv;

            // Public, no-login link so the specialist can just click it.
            ContentDistribution dist = new ContentDistribution();
            dist.Name = name;
            dist.ContentVersionId = cv.Id;
            dist.PreferencesAllowViewInBrowser = true;
            dist.PreferencesAllowOriginalDownload = true;
            dist.PreferencesNotifyOnVisit = false;
            dist.PreferencesLinkLatestVersion = true;
            insert dist;

            ContentDistribution saved = [
                SELECT DistributionPublicUrl, ContentDownloadUrl
                FROM ContentDistribution
                WHERE Id = :dist.Id
                LIMIT 1
            ];
            out.url = String.isNotBlank(saved.DistributionPublicUrl)
                ? saved.DistributionPublicUrl
                : saved.ContentDownloadUrl;
            out.success = String.isNotBlank(out.url);
            if (!out.success) {
                out.error = 'No public URL was generated for the file.';
            }
            return out;
        } catch (Exception e) {
            out.success = false;
            out.error = e.getMessage();
            return out;
        }
    }

    private static Id libraryId() {
        List<ContentWorkspace> ws = [
            SELECT Id FROM ContentWorkspace WHERE Name = :LIBRARY_NAME LIMIT 1
        ];
        return ws.isEmpty() ? null : ws[0].Id;
    }
}
