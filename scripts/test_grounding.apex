// Prints the Prompt Builder grounding guide the agent receives for a product.
System.debug('PRODUCTS: ' + de_ProductService.getProducts().size());
String guide = de_TroubleshootingGrounding.generateGuideForProduct('Velo Induction Cooktop IC 3.0', 'Display shows error code E1');
System.debug('GUIDE_LEN: ' + (guide == null ? 0 : guide.length()));
System.debug('GUIDE_PREVIEW: ' + (guide == null ? 'NULL' : guide.left(1500)));
