/**
 * de_AutoProductService
 * Supplies the car list for the automotive video-feature picker screen (Auto POC set).
 * Guest-accessible, cacheable. Scopes to Family = 'Auto POC' so it never surfaces
 * unrelated demo Product2 data in the org.
 */
// 'without sharing' so the site Guest User can read the POC cars (guest users
// otherwise see zero records without an explicit sharing rule). The query is scoped
// to Family = 'Auto POC', so this only ever exposes the curated demo set.
public without sharing class de_AutoProductService {

    private static final String POC_FAMILY = 'Auto POC';

    public class CarDTO {
        @AuraEnabled public String id;
        @AuraEnabled public String name;
        @AuraEnabled public String description;
        @AuraEnabled public String productCode;
    }

    @AuraEnabled(cacheable=true)
    public static List<CarDTO> getCars() {
        List<CarDTO> out = new List<CarDTO>();
        for (Product2 p : [
            SELECT Id, Name, Description, ProductCode
            FROM Product2
            WHERE Family = :POC_FAMILY AND IsActive = true
            ORDER BY Name
        ]) {
            CarDTO dto = new CarDTO();
            dto.id = p.Id;
            dto.name = p.Name;
            dto.description = p.Description;
            dto.productCode = p.ProductCode;
            out.add(dto);
        }
        return out;
    }
}
