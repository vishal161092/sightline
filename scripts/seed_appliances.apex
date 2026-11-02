// Seeds fictional Velo Home appliances for the video-troubleshooting flow.
// Family = 'Troubleshooting' is what makes a product appear in the picker AND makes it
// troubleshootable (de_ProductService.getProducts filters on that + IsActive).
// Idempotent: replaces prior seeded rows (ProductCode prefix DE-VH-).
delete [SELECT Id FROM Product2 WHERE ProductCode LIKE 'DE-VH-%'];
List<Product2> ps = new List<Product2>{
  new Product2(Name='Velo FrostPro Slushie Maker 1.8L', ProductCode='DE-VH-SLUSH18', Family='Troubleshooting', IsActive=true,
    Description='1.8-litre countertop slushie maker with a freezing cylinder, three mode buttons (Slush, Cocktail, Cool), a lift-off lid and a removable drip tray.'),
  new Product2(Name='Velo Induction Cooktop IC 3.0', ProductCode='DE-VH-IC30', Family='Troubleshooting', IsActive=true,
    Description='2000W induction cooktop with 7 preset menu options and a push-button control panel.'),
  new Product2(Name='Velo Mixer Grinder 750W', ProductCode='DE-VH-MG750', Family='Troubleshooting', IsActive=true,
    Description='750W mixer grinder with 3 stainless-steel jars and a rotary speed knob.'),
  new Product2(Name='Velo Pressure Cooker 5L', ProductCode='DE-VH-PC5L', Family='Troubleshooting', IsActive=true,
    Description='5-litre stainless-steel outer-lid pressure cooker with a precision weight valve and gasket.'),
  new Product2(Name='Velo Electric Kettle 1.5L', ProductCode='DE-VH-EK15', Family='Troubleshooting', IsActive=true,
    Description='1.5-litre 1500W electric kettle with auto shut-off and a detachable 360-degree base.'),
  new Product2(Name='Velo Air Fryer 4L', ProductCode='DE-VH-AF4L', Family='Troubleshooting', IsActive=true,
    Description='4-litre 1400W air fryer with a temperature dial, 30-minute timer and a pull-out frying basket.')
};
insert ps;
System.debug('Inserted Velo Home appliances: ' + ps.size());
