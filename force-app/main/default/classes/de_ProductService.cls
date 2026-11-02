/**
 * de_ProductService
 * Supplies the product list for the video-troubleshooting picker screen (sample appliance set).
 * Guest-accessible, cacheable. Scopes to Family = 'Troubleshooting' so it never surfaces
 * unrelated demo Product2 data in the org.
 */
// 'without sharing' so the site Guest User can read the POC products (guest users
// otherwise see zero records without an explicit sharing rule). The query is scoped
// to Family = 'Troubleshooting', so this only ever exposes the curated demo set.
public without sharing class de_ProductService {

    private static final String POC_FAMILY = 'Troubleshooting';

    public class ProductDTO {
        @AuraEnabled public String id;
        @AuraEnabled public String name;
        @AuraEnabled public String description;
        @AuraEnabled public String productCode;
    }

    @AuraEnabled
    public static List<ProductDTO> getProducts() {
        List<ProductDTO> out = new List<ProductDTO>();
        for (Product2 p : [
            SELECT Id, Name, Description, ProductCode
            FROM Product2
            WHERE Family = :POC_FAMILY AND IsActive = true
            ORDER BY Name
        ]) {
            ProductDTO dto = new ProductDTO();
            dto.id = p.Id;
            dto.name = p.Name;
            dto.description = p.Description;
            dto.productCode = p.ProductCode;
            out.add(dto);
        }
        return out;
    }
}
