/* ==========================================================================
   Porto Piri Piri — real menu, captured read-only from the live CraveDash
   restaurant panel (Product list / Product edit, 28 Sep 2026).
   20 categories, 112 products, variations (option groups) and add-ons.
   Images are the live product images on admin.cravedash.co.uk.
   Variation DSL:  "Group~single!:Opt=price,Opt"   (! = required)
                   "Group~multi(1-3):Opt,Opt"
                   "$SAUCE!" / "$DRINK" / "$SIDE1" ... = shared groups below
   ========================================================================== */
(function () {
  var IMG = 'https://admin.cravedash.co.uk/storage/app/public/';
  var CATS = [
    ['Burger', '2026-05-04-69f8527fe1e0b'], ['Wraps', '2026-05-04-69f853573299f'], ['Piri Piri Chicken', '2026-05-04-69f85465ce4bd'],
    ['PORTO FAVOURITES', '2026-06-04-6a215ed9d2cbf'], ['RICE BOX', '2026-06-04-6a215f21a9e89'], ['BOX MEALS', '2026-06-04-6a215f7184881'],
    ['PORTO KEBABS', '2026-06-04-6a215fba51dfb'], ['QUESADILLA', '2026-06-04-6a21603645494'], ['SIDES', '2026-06-04-6a2160679a161'],
    ['DRINKS', '2026-06-04-6a2160b038295'], ['BURRITO', '2026-06-15-6a2fd1502417c'], ['PLATTERS', '2026-06-04-6a2160fe7fd35'],
    ['DIPS', '2026-06-05-6a22b86510654'], ['KIDS MEAL', '2026-06-05-6a22b883b6dc3'], ['DESSERTS', '2026-06-05-6a22b8b629a2e'],
    ['MILKSHAKES', '2026-06-05-6a22b8ebd702b'], ['ICE CREAM', '2026-06-05-6a22b8efba6c4'], ['Pakoras', '2026-07-29-6a6a00125a316'],
    ['Beef Burger', '2026-08-19-6a85bf0f5a07d'], ['Extras', '2026-09-02-6a97ffda9b6fc']
  ];
  var SUBS = [['Burger', 'Double Burger'], ['Burger', 'Classic Burger']];
  var ADDONS = [['X-tra Hot Chilli', 0.60], ['Spicy Mayo', 0.60], ['Garlic Mayo', 0.60], ['Ketchup', 0.60]];
  var CUISINES = ['Fast Food', 'Italian', 'Desi / Chinese', 'Middle Eastern', 'Steak House / Western', 'Korean Fusion', 'Italian-American'];

  var SHARED = {
    SAUCE: 'Sauce Flavours~single:Naked,Mango & Lime,Lemon & Herb,Mild,Hot,Inferno,Mild Smokey Garlic,Porto Gold (Swt & Smky Hny Grlic)',
    DRINK: 'Drink Choice~single!:Can of Pepsi Max,Can of Irn-Bru,Can of Diet Irn-Bru,Can of Pepsi,Can of Rubicon Mango,Can of Fanta Orange,Can of Fanta Lemon,Can of 7-Up free,Bottled water,Monster Plus=1.25,Can of Coke Zero,Can of Coke,Can of Fanta Fruit Twist',
    SIDE1: 'Side Choice 1~single!:Plain Fries,Curly Fries,Katsu Rice,Garlic Bread,Piri Fries,Cheesy Fries,Onion Rings x 5,Special house rice,Corn on Cob,House salad bowl',
    SIDE2: 'Side Choice 2~single!:Garlic Bread,Piri Fries,Cheesy Fries,Curly Fries,House Salad Bowl,Onion Rings x 5,Katsu Fries,Plain Fries,Corn on Cob,Special house rice',
    SIDE3: 'Side Choice 3~single!:Plain Fries,Piri Fries,Curly Fries,Cheesy Fries,Katsu Fries,Special house rice,Corn on Cob,House Salad,Onion Rings x 5,Garlic Bread',
    DIPS: 'Dips Choice~multi(1-5):Porto Chilli Dip,Piri Piri Mayo Dip,Garlic Mayo Dip,Sweet Chilli Dip,Ketchup',
    CHIPS: 'Chips Choice~single!:Plain Fries,Piri Piri Fries=0.5,Cheesy Fries=1',
    HAL: 'Add Halloumi~single:Add Halloumi=2.25',
    CHEESE: 'Add Cheese~single:Add Cheese=0.75',
    UPG: 'Choose your option~multi(1-2):Upgrade to Piri Fries=0.5,Upgrade to Cheesy Fries=1',
    FRUIT: 'Fruit Shoot Kids~single!:Fruit Shoot Black Currant,Fruit Shoot Orange'
  };
  function R(a, b) { return 'Choose your option~single!:Regular=' + a + ',Meal Deal=' + b; }
  function OWN(a, b, c) { return 'Choose your option~single!:On Its Own=' + a + ',with 2 Reg Sides=' + b + ',Meal Deal=' + c; }

  // [id, name, category, base price, veg, image, description, [variation groups], has addons]
  var P = [
    [168, 'Fried Mozzarella (v)', 'Extras', 3.95, 1, '2026-05-04-69f855098b967', '3 fried mozzarella cheese sticks in a crispy coating', [], 1],
    [169, 'Chicken Nuggets x 5', 'Extras', 3.75, 0, '2026-05-05-69f97a4460636', '5 Chicken Nuggets', [], 1],
    [170, 'Popcorn Chicken', 'KIDS MEAL', 4.75, 0, '2026-05-05-69f97ac911b1a', 'Popcorn Chicken', ['Choose your dip~single!:X-tra hot Chilli,Spicy Mayo,Garlic Mayo,Heinz tomato ketchup']],
    [171, 'Mac & Cheese Bites (5) (V)', 'Extras', 5.45, 1, '2026-05-05-69f97b5853838', 'Cheesy macaroni in crunchy breadcrumbs', []],
    [172, 'Chilli Cheese Bites (5) (v)', 'Extras', 5.45, 1, '2026-05-05-69f97bc1720b6', 'Cream cheese & green chilli bites in a crispy coating', [], 1],
    [173, 'Porto Chicken Deluxe Burger', 'Burger', 6.95, 0, '2026-05-05-69f9817ce6b77', 'Flame-grilled chicken fillet marinated with your choice of Piri Piri sauce', ['Choose your option~single!:Without meal,Make a Meal (fries, dip and a regular can)=3.5', '$SAUCE!', 'Extras~multi(1-2):Halloumi=2.25,Cheese=0.75']],
    [174, 'Spicy Tot Box', 'Piri Piri Chicken', 10.95, 0, '2026-06-03-6a203bc971303', 'Piri Piri chicken chunks with tater tots, melted mozzarella & spicy mayo', ['Tot Box Ingredients Choice~multi(1-3):No Cheese,No Peri Peri Chicken Chunks,No Spicy Mayo', '$SAUCE']],
    [175, 'The Porto Gold Burger', 'Piri Piri Chicken', 0, 0, '2026-06-04-6a214ea2de116', 'Flame-grilled chicken thigh glazed in Porto Gold with corn salsa', ['Choose your option~single!:Regular=9.45,Meal Deal=12.95', '$SAUCE', '$HAL', 'Gold Burger Box Ingredients~multi(1-3):No Corn Salsa,No Red Onion,No Crispy Onion']],
    [177, 'Chicken and Rice Box', 'RICE BOX', 8.95, 0, '2026-06-04-6a2163e02aee2', 'Marinated chicken with your choice of Piri Piri sauce', ['Meal Deal~single:Meal Deal=3.5', '$SAUCE']],
    [178, 'Piri Piri Chicken Wrap', 'Wraps', 6.95, 0, '2026-06-04-6a217f3137706', 'Piri Piri chicken with lettuce, mayo and salsa', ['Meal Deal~single:Meal Deal=3.5', '$SAUCE', 'Wrap Ingredients~multi(1-3):No Lettuce,No Mayo,No Salsa', '$HAL', '$CHEESE']],
    [181, 'Halal Fries', 'SIDES', 2.95, 1, '2026-06-04-6a2184d24b045', '', ['Peri Peri Salt Add On~single:Piri Piri Salt=0.3']],
    [183, 'Double Southern Fried Chicken Burger', 'Burger', 0, 0, '2026-06-05-6a225faf05284', 'Double fried chicken fillet with cheese, lettuce, tomato and mayo', [R(9.95, 13.45)]],
    [184, 'Chicken & Rice Box', 'PORTO FAVOURITES', 0, 0, '2026-06-05-6a22b1e0ea66a', 'Flame-grilled chicken on seasoned rice with your choice of sauce', [R(8.95, 12.45), '$SAUCE']],
    [185, 'Porto Gold Rice Box', 'PORTO FAVOURITES', 0, 1, '2026-06-05-6a22bf628a3f5', 'Chicken thigh glazed in Porto Gold over fragrant rice', [R(9.45, 12.95), '$SAUCE', 'Gold Rice box Ingredients~multi(1-4):No Corn Salsa,No red onion,No Crispy Onion,No Sweet Potato']],
    [186, 'Chicken & Halloumi rice box', 'PORTO FAVOURITES', 0, 0, '2026-06-05-6a22c1428b3a2', 'Flame-grilled chicken & halloumi on seasoned rice', [R(10.45, 13.95), '$SAUCE']],
    [188, 'Chicken Nachos Messy Fries', 'PORTO FAVOURITES', 10.95, 0, '2026-06-05-6a22c5c88cfec', 'Loaded fries with chicken, nacho cheese & house toppings', []],
    [189, 'The Porto Gold Burger (Fav)', 'PORTO FAVOURITES', 0, 1, '2026-06-05-6a22c8f496fa5', 'Chicken thigh glazed in Porto Gold, corn salsa, pickled red onion', [R(9.45, 12.95), '$SAUCE', '$HAL']],
    [190, 'Quarter Chicken', 'Piri Piri Chicken', 0, 0, '2026-06-05-6a22d710a7115', '', [OWN(6.95, 12.9, 10.45), '$SAUCE!', 'Leg or Breast Choice~single!:Leg,Breast']],
    [191, 'Half Chicken', 'Piri Piri Chicken', 0, 0, '2026-06-05-6a22e9edd9617', '', [OWN(11.95, 17.9, 15.45), '$SAUCE!']],
    [192, 'Whole Chicken', 'Piri Piri Chicken', 0, 0, '2026-06-05-6a22eda666797', '', [OWN(20.95, 26.9, 24.45), '$SAUCE!', '$SIDE1', '$SIDE2']],
    [193, 'Butterfly Chicken Breast', 'Piri Piri Chicken', 0, 0, '2026-06-05-6a22fbff5104f', '', [OWN(7.25, 13.2, 10.75), '$SAUCE!']],
    [194, '5 Chicken Wings', 'Piri Piri Chicken', 0, 0, '2026-06-05-6a22fdb5ccc9e', '', [OWN(7.95, 13.9, 11.45), '$SAUCE!']],
    [195, '10 Chicken Wings', 'Piri Piri Chicken', 0, 0, '2026-06-08-6a2697d76e359', '', [OWN(15.45, 21.4, 18.95), '$SAUCE!']],
    [196, '5 Chicken Strips', 'Piri Piri Chicken', 0, 0, '2026-06-08-6a26990205056', '', [OWN(7.95, 13.9, 11.45), '$SAUCE']],
    [197, '10 Chicken Strips', 'Piri Piri Chicken', 0, 0, '2026-06-08-6a2699023e419', '', [OWN(15.45, 21.4, 18.95), '$SAUCE']],
    [198, 'Chicken and Rice Box (Reg)', 'RICE BOX', 0, 0, '2026-06-08-6a26b254afe79', 'Marinated chicken with your choice of Piri Piri sauce', [R(8.95, 12.45), '$SAUCE!']],
    [199, 'Katsu Chicken Rice Box', 'RICE BOX', 0, 0, '2026-06-08-6a26b3915446a', 'Flame-grilled chicken on fragrant rice', [R(9.25, 12.75), '$SAUCE!']],
    [200, 'Porto Gold Rice Box', 'RICE BOX', 0, 0, '2026-06-08-6a26b5b09bd6d', 'Chicken thigh glazed in Porto Gold over fragrant rice', [R(9.45, 12.95), '$SAUCE!', 'Gold Rice box Ingredients~multi(1-4):No Corn Salsa,No red onion,No Crispy Onion,No Sweet Potato']],
    [201, 'Chicken & Halloumi Rice Box', 'RICE BOX', 0, 0, '2026-06-08-6a26b906dcedd', 'Piri Piri spiced grilled halloumi', [R(10.45, 13.95), '$SAUCE!']],
    [202, 'Halloumi Rice Box', 'RICE BOX', 8.95, 0, '2026-06-08-6a26ba8fed3ae', 'Grilled halloumi with your choice of Piri Piri sauce', ['$SAUCE!']],
    [203, 'Spicy Tot Box', 'BOX MEALS', 10.95, 0, '2026-06-08-6a26bcef4f759', '', ['$SAUCE!', 'Tot Box Ingredients Choice~multi(1-3):No Cheese,No Peri Peri Chicken Chunks,No Spicy Mayo']],
    [204, 'Katsu Tot Box', 'BOX MEALS', 9.95, 0, '2026-06-08-6a26be197ea24', 'Crispy tots and mozzarella tossed in katsu spices and garlic', ['Katsu Tot Box Ingredients~multi(1-3):No Cheese,No Garlic Katsu,No Spring Onions']],
    [205, 'Doner Messy Fries', 'BOX MEALS', 10.95, 0, '2026-06-08-6a26bf08c2a57', 'Loaded fries topped with doner & signature sauces', []],
    [206, 'Halal Chicken Nachos Messy Fries', 'BOX MEALS', 10.95, 0, '2026-06-08-6a26bfb98212c', 'Loaded fries with chicken, nacho cheese & house toppings', []],
    [207, 'Boneless Box', 'BOX MEALS', 10.95, 0, '2026-06-08-6a26c37d29bb0', '1 chicken fillet + 2 strips + drink + fries + dip', ['$SAUCE!', '$CHIPS', '$DIPS', '$DRINK']],
    [208, 'Combo Box', 'BOX MEALS', 10.95, 0, '2026-06-08-6a26c7369bdc5', '¼ chicken + 2 wings + drink + fries + dip', ['$SAUCE!', '$DRINK', '$CHIPS', '$DIPS']],
    [209, 'Mix it up Box', 'BOX MEALS', 10.95, 0, '2026-06-08-6a26c9d206c7e', 'Chicken deluxe burger + 2 wings + drink + fries + dip', ['$SAUCE!', '$CHIPS', '$DIPS', '$DRINK']],
    [210, 'Porto Wrap Box', 'BOX MEALS', 10.95, 0, '2026-06-08-6a26cdca3543f', 'Piri Piri chicken wrap + 2 wings + drink + fries + dip', ['$SAUCE!', '$CHIPS', '$DIPS', '$DRINK']],
    [211, 'Porto Chicken Deluxe', 'Burger', 0, 0, '2026-06-08-6a26d635b8772', 'Flame-grilled chicken fillet with lettuce & mayo', ['Choose your option~single!:Regular=6.95,Meal Deal=10.45', '$SAUCE!', 'Deluxe Burger Ingredients~multi(1-2):No Lettuce,No Mayo', '$CHEESE']],
    [212, 'Cheese Burger', 'Beef Burger', 0, 0, '2026-06-08-6a26dd96cadc5', 'Grilled beef patty with cheese, lettuce, onion, tomato, onion rings & mayo', ['Choose your option~single!:Without meal=7.95,Make a meal (chips and can)=11.45', '$SAUCE!', '$HAL']],
    [213, 'BBQ Burger', 'Beef Burger', 0, 0, '2026-06-08-6a26df3da1a9a', 'Flame-grilled beef with onion rings, BBQ sauce & cheese', ['Choose your option~single!:Without meal=7.95,Meal Deal=11.45', '$SAUCE!', '$HAL']],
    [214, 'Southern Fried Chicken Burger', 'Burger', 0, 0, '2026-06-08-6a26e34fe19c7', 'Fried chicken fillet with cheese, lettuce, tomato and mayo', [R(7.95, 11.45), '$SAUCE!', '$HAL']],
    [215, 'Porto Double Chicken Deluxe Burger', 'Burger', 0, 0, '2026-06-08-6a26e494bdbea', 'Double grilled chicken fillet with your choice of Piri Piri sauce', [R(9.75, 13.25), '$SAUCE!', '$HAL']],
    [216, 'Double Southern Fried Chicken Burger', 'Burger', 0, 0, '2026-06-08-6a26e63e1cea3', 'Double fried chicken fillet with cheese, lettuce, tomato and mayo', [R(9.95, 13.45), '$SAUCE!', 'Burger Ingredients~multi(1-4):No Cheese,No Lettuce,No Mayo,No Tomato', '$HAL']],
    [218, 'Double Cheese Burger', 'Beef Burger', 0, 0, '2026-06-08-6a26e7bc3982f', 'Double flame-grilled beef burger with cheese & onion rings', [R(10.45, 13.95), '$SAUCE!', '$HAL']],
    [219, 'Nacho Chicken Burger', 'Burger', 0, 0, '2026-06-08-6a26ec202c992', 'Flame-grilled chicken fillet topped with nachos', [R(8.95, 12.45), '$SAUCE!', '$HAL']],
    [220, 'Fried Mozzarella & Chicken Burger', 'Burger', 0, 0, '2026-06-08-6a26ee2e8cc9a', 'Flame-grilled chicken fillet with fried mozzarella', [R(8.95, 12.45), '$SAUCE!', '$HAL']],
    [221, 'Mountain Burger', 'Burger', 0, 0, '2026-06-08-6a26f0de0b5d2', 'Flame-grilled chicken fillet with hash brown', [R(8.95, 12.45), '$SAUCE!', '$HAL']],
    [222, 'Porto Gold Burger', 'Burger', 0, 0, '2026-06-08-6a26f21ba80cb', 'Chicken thigh glazed in Porto Gold with corn salsa', [R(9.45, 12.95), '$SAUCE!', '$HAL']],
    [223, 'Piri Piri Chicken Wrap (Reg)', 'Wraps', 0, 0, '2026-06-08-6a26f323e75e3', 'Piri Piri chicken with lettuce, mayo and salsa', [R(6.95, 10.45), '$SAUCE!', 'Wrap Ingredients~multi(1-3):No Lettuce,No Mayo,No Salsa', '$HAL', '$CHEESE']],
    [224, 'Hot Honey Chicken Wrap', 'Wraps', 0, 0, '2026-06-08-6a26f4e42a5ac', 'Crispy chicken with lettuce, red onion, cheese, garlic mayo & hot honey', [R(6.95, 10.45), '$SAUCE!', '$HAL']],
    [225, 'Katsu Chicken Wrap', 'Wraps', 0, 0, '2026-06-08-6a26f745378c1', 'Crispy chicken with lettuce, cheese, spring onions & garlic katsu', [R(6.95, 10.45), '$SAUCE!', '$HAL']],
    [226, 'Halloumi Wrap', 'Wraps', 0, 0, '2026-06-09-6a2813abf0cb9', 'Grilled halloumi with onion, tomato, lettuce and spicy mayo', [R(7.45, 10.95), '$SAUCE!']],
    [227, 'Doner Wrap', 'Wraps', 0, 0, '2026-06-09-6a2815718735e', 'Doner meat with lettuce, onion, sweet chilli, mayo and salsa', [R(8.25, 11.75), '$SAUCE!', '$HAL']],
    [228, 'Popcorn Chicken and tots Wrap', 'Wraps', 0, 0, '2026-06-09-6a2817a6e476b', 'Tots and popcorn chicken with spicy mayo and cheese', [R(7.45, 10.95), '$SAUCE!', '$HAL']],
    [229, 'Porto Special Wrap', 'Wraps', 0, 0, '2026-06-09-6a281b4bf1219', 'Piri Piri chicken, lettuce, mayo, salsa, onion rings and cheese', [R(7.75, 11.25), '$SAUCE!', '$HAL']],
    [230, 'Piri Chicken & Fried Mozzarella Wrap', 'Wraps', 0, 0, '2026-06-09-6a282043271a7', 'Flame-grilled chicken with fried mozzarella sticks', [R(8.95, 12.45), '$SAUCE!', '$HAL']],
    [231, 'Cheesy Nacho Wrap', 'Wraps', 0, 0, '2026-06-09-6a282b930825a', 'Chicken with spicy mayo, jalapeños and nacho cheese', [R(8.95, 12.45), '$SAUCE!', '$HAL']],
    [232, 'The Mountain Wrap', 'Wraps', 0, 0, '2026-06-09-6a2835a96bbd5', 'Chicken with hash brown, lettuce, tomato, onion and mayo', [R(8.95, 12.45), '$SAUCE!', '$HAL']],
    [234, 'Porto Grilled Halloumi Kebab', 'PORTO KEBABS', 8.25, 1, '2026-06-09-6a28397901021', 'Grilled halloumi with fresh salad, chilli sauce & garlic mayo', ['$SAUCE!']],
    [235, 'Porto Grilled Chicken Kebab', 'PORTO KEBABS', 8.75, 0, '2026-06-09-6a283aa54f4e8', 'Flame-grilled chicken thigh with fresh salad, chilli sauce & garlic mayo', ['$SAUCE!']],
    [236, 'Porto Grilled Chicken and Halloumi Kebab', 'PORTO KEBABS', 9.45, 0, '2026-06-09-6a283c08d6fe0', 'Chicken thigh & halloumi with fresh salad', ['$SAUCE!']],
    [237, 'Porto Doner and Grilled Halloumi Kebab', 'PORTO KEBABS', 9.68, 0, '2026-06-09-6a283cf790d70', 'Doner & grilled halloumi with fresh salad', ['$SAUCE!']],
    [238, 'Chicken & Cheese Quesadilla', 'QUESADILLA', 0, 0, '2026-06-09-6a28465b359ee', 'Grilled tortilla with chicken, melted cheese and salsa', [R(7.95, 11.45), '$SAUCE!', 'Quesadilla Ingredients~multi(1-2):No Cheese,No Salsa']],
    [239, 'Doner Quesadilla', 'QUESADILLA', 0, 0, '2026-06-10-6a292779e2988', 'Doner in a tortilla with cheese and sweet chilli', [R(7.95, 11.45), '$SAUCE!']],
    [240, 'Hot and Spicy Quesadilla', 'QUESADILLA', 0, 0, '2026-06-10-6a2929e695d1b', 'Chicken, melted cheese, jalapeños & chilli', [R(8.47, 11.97), '$SAUCE!']],
    [241, 'Fries', 'SIDES', 2.95, 1, '2026-06-10-6a292aad72614', 'Super crunchy straight cut chips', ['$UPG'], 1],
    [242, 'Piri Fries', 'SIDES', 3.45, 1, '2026-06-10-6a292b2942ced', 'Straight cut chips with Piri seasoning', ['$UPG'], 1],
    [243, 'Cheesy Fries', 'SIDES', 3.95, 1, '2026-06-10-6a292b9799c9d', 'Straight cut chips with mozzarella cheese', ['$UPG'], 1],
    [244, 'Curly Fries', 'SIDES', 4.25, 1, '2026-06-10-6a292bf8a3f35', 'Fresh and crispy', ['$UPG'], 1],
    [245, 'Onion Rings', 'SIDES', 3.45, 1, '2026-06-10-6a293c4d5f29a', '', ['$UPG'], 1],
    [246, 'Special House Rice', 'SIDES', 3.75, 1, '2026-06-10-6a293ff7a803e', '', []],
    [247, 'Corn on Cob', 'SIDES', 3.25, 1, '2026-06-10-6a2940ae904a6', '', []],
    [248, 'Garlic Bread', 'SIDES', 3.25, 1, '2026-06-10-6a2941b4d8641', '', [], 1],
    [249, 'House Salad Bowl', 'SIDES', 3.45, 1, '2026-06-10-6a29439b61559', 'Lettuce, onions, tomatoes & cucumber', ['Add Protein~multi(1-2):Add Grilled Halloumi=2.25,Add Grilled Chicken=3.95']],
    [250, 'Can', 'DRINKS', 1.25, 1, '2026-06-10-6a2944cfd1c85', 'Pepsi, Tango, Pepsi Max, Irn-Bru, Diet Irn-Bru, 7-Up, Rubicon Mango', ['$DRINK']],
    [251, 'Bottle Water (500 ml)', 'DRINKS', 1.25, 1, '2026-06-10-6a294ca573a87', '', []],
    [252, '1.5 Ltr Bottles', 'DRINKS', 3.25, 0, '2026-06-10-6a294d1ca5945', '', ['$DRINK']],
    [253, 'Monster 500ml', 'DRINKS', 0, 0, '2026-06-10-6a294d8e40eaa', '', ['Choose your option~single!:Monster mango loco=2.45,Monster pipeline punch=2.45,Monster ultra zero sugar=2.45']],
    [254, 'Chicken burrito', 'BURRITO', 7.95, 0, '2026-06-10-6a294e8628dec', 'Flame-grilled chicken with rice, beans & salsa', ['$SAUCE!']],
    [255, 'Doner Burrito', 'BURRITO', 7.95, 0, '2026-06-10-6a294fe349131', 'Doner with rice, salsa and beans', ['$SAUCE!'], 1],
    [256, 'Family Platter', 'PLATTERS', 31.95, 0, '2026-06-10-6a295310e97fc', '1 whole chicken, 5 wings, 3 sides & 3 dips', ['$SAUCE!', '$DIPS', '$SIDE1', '$SIDE2', '$SIDE3']],
    [259, 'Mega Platter', 'PLATTERS', 49.95, 0, '2026-06-10-6a2961b027e30', '2 whole chickens, 5 wings, 5 sides & 3 dips', ['$SAUCE!', '$DIPS', '$SIDE1', '$SIDE2', '$SIDE3'], 1],
    [260, 'Wing Platter', 'PLATTERS', 29.95, 0, '2026-06-10-6a29648677146', '20 wings, 3 sides & 3 dips', ['$SAUCE!', '$DIPS', '$SIDE1', '$SIDE2', '$SIDE3'], 1],
    [261, 'Chicken Strips Kids Meals', 'KIDS MEAL', 6.95, 0, '2026-06-10-6a2965eaf3681', '3 tender Piri Piri strips with your choice of sauce', ['$SAUCE!', '$CHIPS', '$FRUIT']],
    [262, 'Chicken Wings Kids Meals', 'KIDS MEAL', 6.95, 0, '2026-06-10-6a296747e9a4d', '3 juicy chicken wings in a Piri Piri sauce of your choice', ['$SAUCE!', '$CHIPS', '$FRUIT']],
    [263, 'Chicken Burger Kids Meals', 'KIDS MEAL', 6.95, 0, '2026-06-10-6a2968f3c4358', 'Chicken burger in batter with lettuce and mayo', ['$CHIPS', '$FRUIT']],
    [264, 'Chicken Nuggets Kids Meals', 'KIDS MEAL', 6.95, 0, '2026-06-10-6a2969dc4fccc', '5 chicken nuggets in a delicious coating', ['$CHIPS', '$FRUIT']],
    [265, 'Popcorn Chicken Kids Meals', 'KIDS MEAL', 6.95, 0, '2026-06-10-6a296aa3b998b', 'Tasty little chicken bites', ['$CHIPS', '$FRUIT']],
    [266, 'Mac & Cheese Bites Kids Meals', 'KIDS MEAL', 6.95, 0, '2026-06-10-6a296b5f88c67', '', ['$CHIPS', '$FRUIT']],
    [267, 'Ketchup', 'DIPS', 0.75, 1, '2026-06-10-6a296baf7b0b1', '', []],
    [268, 'Garlic Mayo', 'DIPS', 0.75, 1, '2026-06-10-6a296bfe6cffa', '', []],
    [269, 'Spicy Mayo', 'DIPS', 0.75, 1, '2026-06-10-6a296c5256d5b', '', []],
    [270, 'X-tra Hot Chilli', 'DIPS', 0.75, 1, '2026-06-15-6a2fc5e9da337', '', []],
    [271, 'Chocolate Churros', 'DESSERTS', 4.95, 1, '2026-06-10-6a296e019e799', 'Churros in sugar & cinnamon with whipped cream and chocolate', ['Desserts choice~multi(1-2):No whipped cream,No chocolate sauce']],
    [272, 'Biscoff Churros', 'DESSERTS', 4.95, 1, '2026-06-10-6a296de5d678f', '', ['Desserts choice~multi(1-2):No whipped cream,No biscoff sauce']],
    [273, 'Ben & Jerry’s Ice Cream 465 ml', 'ICE CREAM', 0, 0, '2026-06-10-6a296eaf2ca3e', 'Ben & Jerry’s 465 ml tubs', ['Choose your option~single!:Cookie Dough=7.25,Half Baked=7.25,Phish Food=7.25,Chocolate Fudge Brownie=7.25,Caramel Chew Chew=7.25']],
    [275, 'Ben & Jerry’s Caramel Chew Chew Milkshake', 'MILKSHAKES', 7.3, 1, '2026-06-10-6a296ff070c49', 'Thick shake with half a tub of real Ben & Jerry’s', []],
    [276, 'Ben & Jerry’s Chocolate Fudge Brownie Milkshake', 'MILKSHAKES', 7.25, 1, '2026-06-10-6a2970447c016', 'Thick shake with half a tub of real Ben & Jerry’s', []],
    [278, 'Ben & Jerry’s Phish Food Milkshake', 'MILKSHAKES', 7.25, 1, '2026-06-10-6a2970e651486', 'Thick shake with half a tub of real Ben & Jerry’s', []],
    [279, 'Ben & Jerry’s Half Baked Milkshake', 'MILKSHAKES', 7.25, 1, '2026-06-10-6a297129456ac', 'Thick shake with half a tub of real Ben & Jerry’s', []],
    [280, 'Ben & Jerry’s Cookie Dough Milkshake', 'MILKSHAKES', 7.25, 1, '2026-06-10-6a2971753d550', 'Thick shake with half a tub of real Ben & Jerry’s', []],
    [1060, 'Porto Doner Kebab', 'PORTO KEBABS', 8.75, 0, '2026-09-02-6a97ee05b5c56', 'Doner with fresh salad, salad sauce and garlic mayo', ['$SAUCE!']],
    [1061, 'Katsu Fries', 'SIDES', 3.45, 0, '2026-09-02-6a97fbcae4ca4', '', ['$UPG'], 1],
    [1062, 'Halloumi Fries', 'Extras', 3.95, 1, '2026-09-02-6a98012dd6f8b', '', ['$UPG'], 1],
    [1063, 'Popcorn Chicken Box', 'Extras', 5.95, 0, '2026-09-02-6a9810fd6919b', '', [], 1],
    [1064, 'Hot Honey Chicken Strips (4)', 'Extras', 5.75, 0, '2026-09-02-6a98154667291', '', [], 1],
    [1065, 'Loaded Nachos (v)', 'Extras', 6.45, 1, '2026-09-02-6a9816b336c4f', 'Topped with salsa, nacho cheese & jalapeños', [], 1],
    [1066, 'Loaded Chicken Nachos', 'Extras', 9.45, 0, '2026-09-02-6a9818193e3b2', 'Topped with chicken, salsa, nacho cheese & jalapeños', [], 1],
    [1067, 'Share Box', 'Extras', 16.45, 0, '2026-09-02-6a9818f82c94c', '5 wings, 5 strips, 5 mozzarella sticks & 2 dips', [], 1],
    [1068, 'Energy Drinks', 'DRINKS', 2.45, 0, '2026-09-02-6a981b8c631ee', 'Monster', []]
  ];

  function parseGroup(spec, i) {
    var req = false;
    if (spec[0] === '$') { req = spec.slice(-1) === '!'; var key = spec.replace(/[$!]/g, ''); spec = SHARED[key]; if (req) spec = spec.replace(/~(single|multi[^:]*)(!?):/, '~$1!:'); }
    var m = spec.match(/^(.*?)~(single|multi)(?:\((\d+)-(\d+)\))?(!?):(.*)$/);
    if (!m) return null;
    return {
      id: 'g' + i, name: m[1], type: m[2], min: m[3] ? +m[3] : (m[5] ? 1 : 0), max: m[4] ? +m[4] : 1, required: m[5] === '!' || req,
      values: m[6].split(/,(?![^()]*\))/).map(function (v, j) { var p = v.split('='); return { id: 'o' + j, label: p[0].trim(), price: p[1] ? +p[1] : 0 }; })
    };
  }

  window.PORTO_SEED = {
    IMG: IMG,
    categories: CATS.map(function (c, i) { return { name: c[0], image: IMG + 'category/' + c[1] + '.png', priority: 10 }; }),
    subcategories: SUBS,
    addons: ADDONS.map(function (a, i) { return { id: 'ad' + (i + 1), name: a[0], price: a[1], tax: 0 }; }),
    cuisines: CUISINES,
    products: P.map(function (p) {
      return { id: 'p' + p[0], live_id: p[0], name: p[1], category: p[2], price: p[3], veg: !!p[4], image: IMG + 'product/' + p[5] + '.png', description: p[6], variations: p[7].map(parseGroup).filter(Boolean), addons: p[8] ? ADDONS.map(function (a) { return a[0]; }) : [] };
    })
  };
})();
