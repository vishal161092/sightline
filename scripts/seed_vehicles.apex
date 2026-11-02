// Seeds fictional Velo Motors vehicles for the vehicle feature-tour flow.
// getCars() reads Product2 WHERE Family='Auto POC' AND IsActive=true, and the agent grounds
// on the Description field, so each description carries exterior / interior / tech detail.
// Idempotent: replaces prior seeded rows (ProductCode prefix DE-AUTO-).
delete [SELECT Id FROM Product2 WHERE ProductCode LIKE 'DE-AUTO-%'];
List<Product2> cars = new List<Product2>{
  new Product2(Name='Velo Summit VX7', ProductCode='DE-AUTO-VX7', Family='Auto POC', IsActive=true,
    Description='Velo Summit VX7 (flagship 5/7-seat SUV). Exterior: twin-slat grille, C-shaped LED daytime lights, '
      + 'pop-out flush door handles, 18-inch dual-tone alloys, shark-fin antenna. Interior: dual 10.25-inch curved '
      + 'displays (instrument cluster + infotainment), panoramic sunroof, 12-speaker audio, dual-zone climate. '
      + 'Tech & safety: driver-assistance suite (adaptive cruise, lane-keep assist, automatic emergency braking), '
      + '7 airbags, 360-degree camera, drowsiness detection and a connected-car app.'),
  new Product2(Name='Velo Ridge N', ProductCode='DE-AUTO-RIDGEN', Family='Auto POC', IsActive=true,
    Description='Velo Ridge N (rugged body-on-frame SUV). Exterior: upright clamshell bonnet, six-slat grille, '
      + 'LED daytime lights, 18-inch diamond-cut alloys, roof rails. Interior: dual-tone leatherette seats, '
      + '8-inch touchscreen with wireless phone projection, electronic sunroof. Tech & safety: 4WD with terrain '
      + 'modes (Normal/Snow/Mud/Sand), locking differential, 6 airbags, hill-hold and hill-descent control.'),
  new Product2(Name='Velo Trek 5-Door', ProductCode='DE-AUTO-TREK5', Family='Auto POC', IsActive=true,
    Description='Velo Trek 5-Door (lifestyle off-roader). Exterior: vertical-slat grille, round LED headlamps, '
      + 'squared wheel arches, 19-inch alloys, side-opening tailgate, high ground clearance. Interior: 10.25-inch '
      + 'infotainment and digital cluster, panoramic sunroof, washable cabin surfaces. Tech & safety: 4x4 with '
      + 'low-range transfer case, 6 airbags, 360-degree camera, drive modes and off-road telemetry on screen.'),
  new Product2(Name='Velo Spark Compact', ProductCode='DE-AUTO-SPARK', Family='Auto POC', IsActive=true,
    Description='Velo Spark Compact (sub-4-metre compact SUV). Exterior: connected LED light bar, heartbeat-style '
      + 'LED tail lamps, 17-inch alloys, flush door handles. Interior: panoramic sunroof, twin 10.25-inch screens, '
      + '7-speaker audio, dual-zone climate, wireless charging. Tech & safety: driver-assistance suite, 6 airbags, '
      + 'blind-view monitor, 360-degree camera.'),
  new Product2(Name='Velo Volt 6', ProductCode='DE-AUTO-VOLT6', Family='Auto POC', IsActive=true,
    Description='Velo Volt 6 (all-electric coupe-SUV). Exterior: split-LED signature, aerodynamic flush surfaces, '
      + 'connected LED tail bar, aero alloys, low coupe roofline. Interior: twin 12.3-inch displays, floating '
      + 'centre console, panoramic glass roof, 16-speaker audio, head-up display. Tech & safety: about 550 km '
      + 'range, DC fast charging, 7 airbags, over-the-air updates.'),
  new Product2(Name='Velo Volt 9', ProductCode='DE-AUTO-VOLT9', Family='Auto POC', IsActive=true,
    Description='Velo Volt 9 (flagship all-electric SUV-coupe). Exterior: full-width connected LED light bars, '
      + 'illuminated logo, frameless doors, flush handles, fastback roofline. Interior: triple-screen dashboard '
      + '(three 12.3-inch displays), augmented-reality head-up display, panoramic glass roof, 16-speaker audio, '
      + 'powered reclining rear seats. Tech & safety: about 650 km range, 175 kW DC fast charging, 5 radars and a '
      + 'front camera for driver assistance.')
};
insert cars;
System.debug('Inserted Velo Motors vehicles: ' + cars.size());
