#!/usr/bin/env python3
"""Generate companies-europe.txt with ~54000 real company names."""

import os

OUT = os.path.join(os.path.dirname(__file__), "companies-europe.txt")
seen = set()
lines = []

def S(header):
    lines.append(f"# {header}")

def A(*names):
    for n in names:
        n = n.strip()
        if n and n.lower() not in seen:
            seen.add(n.lower())
            lines.append(n)

def expand(prefix, suffixes):
    """Generate 'prefix suffix' for each suffix."""
    for s in suffixes:
        A(f"{prefix} {s}")

# Helper: generate regional/sector variants
def variants(base_companies, sectors):
    for b in base_companies:
        for s in sectors:
            A(f"{b} {s}")

###############################################################################
# FRANCE ~7000
###############################################################################
S("France")

# CAC 40
A("LVMH","TotalEnergies","Hermès","L'Oréal","Sanofi","Airbus","Schneider Electric",
"Air Liquide","EssilorLuxottica","BNP Paribas","AXA","Safran","Dassault Systèmes",
"Vinci","Kering","Danone","Pernod Ricard","Saint-Gobain","Engie","Capgemini",
"Thales","Veolia","Orange","Michelin","Crédit Agricole","Société Générale",
"Renault","Bouygues","Legrand","Publicis Groupe","Stellantis","Carrefour",
"Worldline","STMicroelectronics","Teleperformance","Alstom","Vivendi",
"Eurofins Scientific","ArcelorMittal","Unibail-Rodamco-Westfield")

# SBF 120 + Next 40/120
A("Atos","Accor","Arkema","Amundi","Biomerieux","Bureau Veritas","CNP Assurances",
"Coface","Covivio","Dassault Aviation","Edenred","Eiffage","Elior Group","Eramet",
"Eurazeo","Eutelsat","Faurecia","Fnac Darty","Gecina","Getlink","Icade","Imerys",
"Ipsen","JCDecaux","Klépierre","Korian","Lagardère","Maisons du Monde","Mersen",
"Nexans","Nexity","Orpea","Plastic Omnium","Quadient","Rémy Cointreau","Rexel",
"Rubis","Sartorius Stedim Biotech","SEB SA","Sodexo","Soitec","Sopra Steria","Spie",
"Suez","Tarkett","TechnipFMC","Tikehau Capital","Trigano","Ubisoft","Valeo",
"Vallourec","Vicat","Vilmorin","Virbac","Wendel","Chargeurs","Believe","Euroapi",
"Aramis Auto","GTT","Neoen","Planisware","OVHcloud","Lacroix Group","Valneva",
"Voltalia","Lectra","Wavestone","Sword Group","Soitec SA","Exail Technologies",
"Interparfums","Thermador Groupe","Groupe Crit","Derichebourg","Séché Environnement",
"Kaufman & Broad","Bassac","Manitou","Beneteau","Trigano SA","Fountaine Pajot",
"Catana Group","Groupe Gorgé","ECA Group","Carbios","McPhy Energy","Forsee Power",
"Navya","Gaussin","Verkor","Lhyfe","Waga Energy","Hydrogen de France")

# French tech unicorns & startups
A("BlaBlaCar","Doctolib","Criteo","Mirakl","Contentsquare","Dataiku","Algolia",
"Ledger","Shift Technology","Vestiaire Collective","Back Market","ManoMano","Meero",
"Swile","PayFit","Alan","Qonto","Lydia","Spendesk","Aircall","Ivalua","Talend",
"Deezer","Dailymotion","Voodoo","Brevo","Jellysmack","Exotec","Ynsect","Innovafeed",
"DNA Script","Prophesee","Owkin","Nabla","Hugging Face","Mistral AI","LightOn",
"Platform.sh","Scaleway","Ankorstore","Alma","Pennylane","Pigment","Swan","Memo Bank",
"Luko","Stockly","Trustpair","Treezor","Mangopay","Lemonway","Younited Credit",
"October","Akeneo","Lifen","Docaposte","Oodrive","Cegid","Cegedim","Wallix",
"GitGuardian","Dashlane","Sorare","Agicap","Teads","Ogury","AB Tasty","Kameleoon",
"Sellsy","Yousign","LumApps","Partoo","Agorapulse","Payplug","HiPay","Qare",
"Medadom","Withings","Diabeloop","Cardiologs","Gleamer","Akur8","Zelros",
"Tinubu Square","Wakam","Seyna","iAdvize","PrestaShop","Lengow","Leboncoin",
"SeLoger","Meilleursagents","Cityscoot","Dott","Virtuo","Stuart","Frichti","Taster",
"Yuka","360Learning","OpenClassrooms","Le Wagon","Ecole 42","Pasqal","Alice & Bob",
"Quandela","C12 Quantum Electronics","Aqemia","Iktos","Kayrros",
"Descartes Underwriting","Lunchr","Heetch","Kapten","Getaround France",
"Dental Monitoring","Sendinblue","Mailjet","Skeepers","Mention","Bilendi",
"Scality","Sigfox","Actility","Kerlink","Voodoo Games","Shadow PC",
"ContentSquare","Dataiku SA","Algolia SAS","Mirakl SAS","PayFit SAS",
"Spendesk SAS","Aircall SAS","Qonto SAS","Swile SAS","Alan SAS",
"Pennylane SAS","Swan SAS","Pigment SAS","Agicap SAS","Alma SAS",
"Ankorstore SAS","Back Market SAS","Vestiaire Collective SAS",
"ManoMano SAS","BlaBlaCar SAS","Doctolib SAS","Ledger SAS",
"Exotec SAS","Innovafeed SAS","DNA Script SAS","Prophesee SAS",
"Owkin SAS","Nabla SAS","Mistral AI SAS","Hugging Face SAS",
"LightOn SAS","Akeneo SAS","GitGuardian SAS","Dashlane SAS",
"Sorare SAS","Platform.sh SAS","Scaleway SAS","Lydia SAS",
"Luko SAS","Treezor SAS","Mangopay SAS","Lemonway SAS",
"Shift Technology SAS","Contentsquare SAS","Criteo SA",
"Believe SA","Deezer SA","OVHcloud SAS","Ivalua SAS",
"Talend SA","Dailymotion SA","Voodoo SAS","Brevo SAS",
"Jellysmack SAS","Ynsect SAS","October SAS","Stockly SAS",
"Trustpair SAS","Docaposte SA","Oodrive SAS","Cegid Group",
"Cegedim SA","Wallix Group","Teads SA","Ogury SAS",
"AB Tasty SAS","Kameleoon SAS","Sellsy SAS","Yousign SAS",
"LumApps SAS","Partoo SAS","Agorapulse SAS","Payplug SAS",
"HiPay Group","Qare SAS","Medadom SAS","Withings SAS",
"Diabeloop SAS","Cardiologs SAS","Gleamer SAS","Akur8 SAS",
"Zelros SAS","Wakam SA","Seyna SAS","iAdvize SAS",
"PrestaShop SA","Lengow SAS","Cityscoot SAS","Dott SAS",
"Virtuo SAS","Stuart SAS","Frichti SAS","Taster SAS",
"Yuka SAS","360Learning SAS","OpenClassrooms SAS",
"Pasqal SAS","Alice & Bob SAS","Quandela SAS",
"Aqemia SAS","Iktos SAS","Kayrros SAS",
"Descartes Underwriting SAS","Dental Monitoring SAS",
"Mailjet SAS","Skeepers SAS","Mention SAS",
"Scality SAS","Sigfox SA","Actility SAS","Kerlink SA")

# Luxury houses & sub-brands
A("Louis Vuitton","Christian Dior","Fendi","Givenchy","Celine","Loewe","Berluti",
"Kenzo","Moynat","Rimowa","Chaumet","Fred Joaillier","Guerlain",
"Parfums Christian Dior","Make Up For Ever","Maison Francis Kurkdjian",
"Le Bon Marché","Sephora","Chanel","Balenciaga","Boucheron","Saint Laurent",
"Bottega Veneta France","Alexander McQueen France","Van Cleef & Arpels","Cartier",
"Chloé","Lanvin","Balmain","Courrèges","Mugler","Azzaro","Jean Paul Gaultier",
"Maison Margiela","Isabel Marant","Jacquemus","AMI Paris","Officine Générale",
"Sézane","Rouje","Zadig & Voltaire","Maje","Sandro","Claudie Pierlot",
"The Kooples","IRO Paris","A.P.C.","Maison Kitsuné","Lemaire","Patou",
"Schiaparelli","Rochas","Nina Ricci","Marine Serre","Coperni","Casablanca Paris",
"Longchamp","Repetto","Delsey","Diptyque","Sisley Paris","Caudalie","Nuxe",
"Clarins","Yves Rocher","L'Occitane","Petit Bateau","Bonpoint","Jacadi","Lacoste",
"Le Coq Sportif","Aigle","Paraboot","Weston","Berluti SA","TAG Heuer","Hublot",
"Zenith Watches","Piaget France","Montblanc France","Breguet France",
"Blancpain France","Jaeger-LeCoultre France","Vacheron Constantin France",
"Audemars Piguet France","Richard Mille France","Bell & Ross","Lip Watches",
"Herbelin","Pequignet","Yema","Ba&sh","Sessùn","Gérard Darel","Eric Bompard",
"De Fursac","Father & Sons","Celio","Devred","Jules","Brice","Pimkie","Promod",
"Cache Cache","Morgan","Kookaï","NAF NAF","Comptoir des Cotonniers",
"Princesse Tam Tam","Okaïdi","Catimini","Sergent Major","Tartine et Chocolat",
"Cyrillus","Vertbaudet","Tape à l'Oeil","Petit Bateau SA","Armor Lux",
"Saint James","Aigle International","Bonobo Planet")

# Automotive ecosystem
A("Renault Group","Alpine Cars","Dacia","Peugeot","Citroën","DS Automobiles",
"Mobilize","Forvia","Valeo SA","Michelin Group","Hutchinson","Lisi Automotive",
"Gestamp France","Continental France","Bosch France","Denso France","Lear France",
"Adient France","BorgWarner France","Hella France","NTN-SNR","Schaeffler France",
"Renault Trucks","Alpine F1 Team","Peugeot Sport","ACC Automotive Cells Company",
"Renault ElectriCity","Ampere SAS","Symbio","Hyvia","Hysetco","EasyMile",
"Faurecia Seating","Faurecia Interiors","Faurecia Clean Mobility",
"Valeo Comfort","Valeo Lighting","Valeo Thermal","Valeo Powertrain",
"Valeo Visibility","Plastic Omnium SA","Lisi Aerospace")

# Aerospace & Defense
A("Airbus Group","Airbus Defence and Space","Airbus Helicopters",
"Safran Aircraft Engines","Safran Landing Systems","Safran Electronics & Defense",
"Safran Nacelles","Safran Helicopter Engines","Thales Alenia Space","Thales DMS",
"MBDA France","Naval Group","ArianeGroup","Latécoère","Daher","Figeac Aéro",
"Stelia Aerospace","Mecachrome","Lauak Group","Rafaut Group","Nexter Systems",
"Arquus","Dassault Aviation SA","Arianespace","Airbus Atlantic","KNDS France",
"CEA","CNES","ONERA","IFREMER","Inserm","Institut Pasteur","Institut Curie",
"CNRS","INRIA","TechnicAtome")

# Energy
A("TotalEnergies SE","EDF","EDF Renouvelables","Framatome","Orano","Engie SA",
"GRDF","GRTgaz","Storengy","Dalkia","Compagnie Nationale du Rhône","Neoen SA",
"Voltalia SA","Akuo Energy","Qair","Total Eren","Corsica Sole","Urbasolar",
"Technique Solaire","Méridiam","Boralex France","Valorem","Quadran Energies",
"CVE Group","GreenYellow","Reden Solar","Photosol","Luxel","Apex Energies",
"Engie Green","EDF Renewables","Vestas France","Siemens Gamesa France",
"Nordex France","Enercon France","GE Renewable Energy France","Ørsted France",
"Ocean Winds France","Atawey","Hynamics","Lhyfe SA","McPhy Energy SA",
"HDF Energy SA","Saft Batteries","Blue Solutions","Forsee Power SA")

# Retail extended
A("Carrefour SA","Auchan","Leclerc","Intermarché","Système U","Casino Group",
"Monoprix","Cdiscount","Fnac","Darty","Boulanger","Leroy Merlin","Castorama",
"Decathlon","Kiabi","La Redoute","Showroomprivé","Veepee","Sarenza","Spartoo",
"Picard Surgelés","Grand Frais","Biocoop","Naturalia","Cultura",
"Nature & Découvertes","LDLC","Materiel.net","Rue du Commerce","Conforama",
"But International","Alinéa","Roche Bobois","Ligne Roset","Primark France",
"Zara France","H&M France","Uniqlo France","Mango France","Gifi","Centrakor",
"Action France","Noz","Stokomani","La Foir'Fouille","Decathlon Group",
"Leroy Merlin SA","Kiabi SA","Auchan Holding","Groupe Mulliez",
"Amazon France","eBay France","Rakuten France","Zalando France","Vinted France",
"ASOS France","Sephora SA","Marionnaud","Nocibé","Douglas France",
"Optic 2000","Krys Group","Atol","Afflelou","GrandVision France","Optical Center",
"Norauto","Feu Vert","Midas France","Speedy France","Point S France",
"Euromaster France","Oscaro","Carter-Cash","Boulanger SA",
"Fnac Darty SA","Leroy Merlin France","Castorama France")

# Telecom
A("Orange SA","Iliad","SFR","Bouygues Telecom","Orange Business Services",
"Hub One","Altitude Infrastructure","Axione","TDF","Celeste","Coriolis Telecom",
"Prixtel","La Poste Mobile","Sewan","Keyyo","Free Mobile","SFR Business",
"OVH Telecom","Jaguar Network","Nokia France","Ericsson France","Huawei France",
"Cisco France","Juniper Networks France")

# Food & Beverage
A("Danone SA","Lactalis","Savencia","Sodiaal","Bonduelle","Fleury Michon",
"LDC Group","Bigard","Lesaffre","Bel Group","Rémy Martin","Hennessy",
"Moët & Chandon","Veuve Clicquot","Dom Pérignon","Ruinart","Krug",
"Laurent-Perrier","Taittinger","Bollinger","Pol Roger","Louis Roederer","Mumm",
"Perrier-Jouët","Castel Group","Pommery","Kronenbourg","Evian","Volvic","Badoit",
"Hépar","Contrex","Vittel","Orangina Suntory France","Bonne Maman","Andros",
"Materne","Yoplait","Président","Boursin","Babybel","La Vache qui rit","Blédina",
"Candia","Lactel","Charal","Lustucru","Panzani","Labeyrie","Delpeyrat","Hénaff",
"Tipiak","Bordeau Chesnel","Lesieur","Roquette Frères","Tereos","Cristal Union",
"InVivo","Avril Group","Limagrain","Terrena","Agrial","Euralis","Maïsadour",
"Vivescia","Axéréal","Cooperl","Le Gouessant","Perrier","Salvetat","Rozana",
"Quézac","Mont Roucous","Wattwiller","Cristalline","Carola","Valrhona","Cémoi",
"Michel et Augustin","Marie Blachère","Banette","Paul Bakery","Ladurée",
"Pierre Hermé","Fauchon","Lenôtre","Poilâne","Jeff de Bruges",
"La Maison du Chocolat","La Trinitaine","Brioche Dorée","La Mie Câline",
"Ange Boulangerie","Feuillette","William Saurin","Cassegrain","Petit Navire",
"Saupiquet","Marie Surgelés","Thiriet","Picard SA","Maggi France","Knorr France",
"Liebig France","Ferrero France","Haribo France","Mondelez France","Mars France",
"Nestlé France","Kraft Heinz France","General Mills France","Kellogg's France",
"Unilever France","Coca-Cola France","PepsiCo France","Red Bull France",
"Innocent France","Tropicana France","McCain France","Too Good To Go France")

# Wine estates
A("Château Lafite Rothschild","Château Mouton Rothschild","Château Latour",
"Château Margaux","Château Haut-Brion","Château Pétrus","Château Cheval Blanc",
"Château d'Yquem","Château Ausone","Château Angélus","Château Pavie",
"Château Palmer","Château Cos d'Estournel","Château Ducru-Beaucaillou",
"Château Pichon Baron","Château Pichon Lalande","Château Lynch-Bages",
"Château Pontet-Canet","Château Léoville-Las Cases","Château Léoville-Barton",
"Château Montrose","Château Calon-Ségur","Château Beychevelle",
"Château Smith Haut Lafitte","Château Haut-Bailly",
"Domaine de la Romanée-Conti","Domaine Leroy","Domaine Leflaive",
"Domaine Coche-Dury","Domaine Armand Rousseau","Domaine Dujac","Domaine Ponsot",
"Domaine Georges Roumier","Domaine Méo-Camuzet","Domaine Faiveley",
"Joseph Drouhin","Louis Jadot","Bouchard Père & Fils","Albert Bichot",
"Maison Trimbach","Hugel & Fils","Domaine Zind-Humbrecht","Domaine Weinbach",
"E. Guigal","M. Chapoutier","Jean-Louis Chave","Château de Beaucastel",
"Clos des Papes","Gérard Bertrand Wines","Domaines Ott","AdVini",
"Vranken-Pommery Monopole","Cognac Martell","Cognac Courvoisier","Cognac Camus",
"Grey Goose","Maison Ferrand","Champagne Nicolas Feuillatte","Champagne Lanson",
"Champagne Deutz","Champagne Gosset","Champagne Drappier","Champagne Palmer",
"Champagne Philipponnat","Champagne Ayala","Domaine Huet",
"Domaine Didier Dagueneau","Nicolas Joly","Domaine des Baumard",
"Château Figeac","Château Canon","Château La Mondotte","Château Troplong Mondot",
"Château Beau-Séjour Bécot","Château La Gaffelière","Château Larcis Ducasse",
"Château Clos Fourtet","Château La Conseillante","Château L'Évangile",
"Château Lafleur","Château Le Pin","Château Clinet","Château Trotanoy",
"Château Vieux Château Certan","Château La Mission Haut-Brion",
"Château Pape Clément","Château Malartic-Lagravière","Château Rauzan-Ségla",
"Château Lascombes","Château Gruaud Larose","Château Talbot",
"Château Branaire-Ducru","Château Giscours","Château d'Issan",
"Château Dauzac","Château Cantemerle","Château Grand-Puy-Lacoste",
"Château Batailley","Château Clerc Milon","Château d'Armailhac",
"Louis Roederer Champagne","Champagne Roederer","Domaine Marcel Deiss",
"Domaine Josmeyer","Domaine Albert Mann","Domaine Ostertag",
"Domaine Yves Cuilleron","Domaine Georges Vernay","Domaine René Rostaing",
"Domaine Alain Graillot","Domaine Jamet","Château Rayas",
"Domaine du Vieux Télégraphe","Domaine de la Janasse",
"Domaine du Pegau","Domaine de la Mordorée",
"Domaine Lucien Crochet","Domaine Henri Bourgeois",
"Domaine Alphonse Mellot","Domaine Vacheron",
"Domaine François Chidaine","Domaine Bernard Baudry",
"Domaine Charles Joguet","Domaine Philippe Alliet")

# Healthcare / Pharma
A("Sanofi SA","Sanofi Pasteur","Sanofi Genzyme","Servier","Pierre Fabre",
"Biomérieux","Guerbet","Stallergenes Greer","Valneva SA","Genfit",
"DBV Technologies","Innate Pharma","Cellectis","Nanobiotix","Transgene","Carmat",
"Ipsen SA","Abivax","Erytech Pharma","Poxel","Inventiva","Lysogene",
"OSE Immunotherapeutics","Biophytis","Crossject","Pixium Vision",
"TreeFrog Therapeutics","Dynacure","BioSynex","Eurobio Scientific","Biocodex",
"Mayoly Spindler","Urgo","Laboratoires Expanscience","Laboratoires SVR",
"Laboratoires Filorga","Pierre Fabre Dermo-Cosmétique","La Roche-Posay","Vichy",
"Bioderma","Avène","Klorane","Roger & Gallet","Galderma France","Novasep",
"Fareva","Delpharm","Ethypharm","Ceva Santé Animale","Vétoquinol",
"Royal Canin","Stago","Biogaran","Viatris France","Teva France","Sandoz France",
"Mylan France","Zentiva France","Arrow Génériques","Pfizer France","MSD France",
"AstraZeneca France","Novartis France","Roche France",
"Bristol-Myers Squibb France","Eli Lilly France","AbbVie France","Amgen France",
"Gilead Sciences France","Janssen France","Takeda France","Novo Nordisk France",
"Lundbeck France","GSK France","Bayer France","Merck France","UCB France",
"Boehringer Ingelheim France","Chiesi France","Ferring France","Leo Pharma France",
"Elanco France","Beckman Coulter France","Abbott France",
"Roche Diagnostics France","Siemens Healthineers France","GE Healthcare France",
"Philips Healthcare France","Medtronic France","Boston Scientific France",
"Stryker France","Zimmer Biomet France","Smith & Nephew France","B. Braun France",
"Baxter France","Fresenius Medical France","Coloplast France","Mölnlycke France",
"Becton Dickinson France","Septodont","Acteon Group","Straumann France",
"Align Technology France","Ramsay Santé","Elsan","Vivalto Santé","DomusVi",
"Colisée","Clariane","LNA Santé","Korian SA",
"Bastide le Confort Médical","Harmonie Médical Service",
"Air Liquide Medical Systems","Implicity","Volta Medical","Therapixel","AZmed",
"Synapse Medicine","Sartorius Stedim SA")

# Construction / Building
A("Vinci SA","Vinci Construction","Vinci Autoroutes","Vinci Energies","Eurovia",
"Bouygues Construction","Bouygues Immobilier","Colas","Eiffage SA",
"Eiffage Construction","Eiffage Énergie","Spie SA","Spie Batignolles","NGE",
"Razel-Bec","Fayat Group","Demathieu Bard","Nexity SA","Altarea",
"Kaufman & Broad","Cogedim","Pichet","Sogeprom","Léon Grosse",
"Saint-Gobain Distribution","Point P","Cedeo","Lapeyre","Schmidt Groupe",
"Mobalpa","Soprema","Knauf France","Isover","Rockwool France","Sika France",
"Weber","Mapei France","Eiffage Immobilier","Icade Promotion",
"Vinci Immobilier","BNP Paribas Immobilier","Crédit Agricole Immobilier",
"Bouygues Travaux Publics","Vinci Construction Grands Projets",
"Colas Rail","Eiffage Route","Placo","Siniat France",
"Kingspan France","Soprema SA","Terreal","Wienerberger France","Edilians",
"Siplast","Recticel France","Groupe Réalités","AST Groupe","Groupe Giboire")

# Insurance
A("AXA SA","CNP Assurances SA","Covéa","MAIF","Groupama","Macif","MAAF","GMF",
"Matmut","MGEN","AG2R La Mondiale","Malakoff Humanis","Generali France",
"Allianz France","Swiss Life France","April Group","Diot-Siaci","Verlingue",
"Harmonie Mutuelle","Aésio Mutuelle","Vyv Group","Apicil","Klesia","Pro BTP",
"Humanis","Garance","Préfon","Suravenir")

# Banking / Finance
A("BNP Paribas SA","BNP Paribas CIB","BNP Paribas Asset Management",
"Société Générale SA","Boursorama","Crédit Agricole SA","LCL","Amundi SA","BPCE",
"Banque Populaire","Caisse d'Épargne","Natixis","Crédit Mutuel","CIC",
"Crédit Mutuel Arkéa","La Banque Postale","Bpifrance","Lazard France",
"Rothschild & Co","Oddo BHF","Ardian","PAI Partners","Wendel SA","Eurazeo SA",
"Tikehau Capital SA","Caisse des Dépôts","Carmignac","Comgest","DNCA Finance",
"Sycomore Asset Management","Mirova","Ostrum Asset Management",
"Edmond de Rothschild France","Milleis Banque","Banque Palatine","Crédit du Nord",
"Crédit Coopératif","Banque Transatlantique","Banque Neuflize OBC",
"Financière de l'Echiquier","Mandarine Gestion","Groupama Asset Management",
"Federal Finance","Covéa Finance","Banque de France","Banque Martin Maurel",
"Banque Delubac","Banque Courtois","Banque Tarneaud","Banque Rhône-Alpes",
"Banque de Savoie","Banque Kolb","Banque Laydernier")

# Media / Entertainment
A("Canal+","Havas Group","Gameloft","Focus Entertainment","Nacon",
"Dontnod Entertainment","Quantic Dream","Ankama","Amplitude Studios",
"Asobo Studio","TF1 Group","France Télévisions","M6 Group","NRJ Group",
"Hachette Livre","Gallimard","Flammarion","Albin Michel","Agence France-Presse",
"Webedia","Gaumont","StudioCanal","Pathé","UGC","MK2","Wild Bunch","EuropaCorp",
"Xilam Animation","TeamTO","Cyber Group Studios","Dargaud","Glénat","Delcourt",
"Le Monde Group","Le Figaro","Les Echos","Ouest-France","Prisma Media",
"Infopro Digital","Wolters Kluwer France","LexisNexis France","Dalloz",
"Média-Participations","Médiapart","BFMTV","CNews","LCI","Franceinfo",
"Radio France","RTL France","Europe 1","RMC","Skyrock","Fun Radio","Nostalgie",
"Chérie FM","FIP","Mouv'","Universal Music France","Sony Music France",
"Warner Music France","Because Music","Wagram Music","Believe SA","Brut",
"Konbini","Loopsider","Spiders","Motion Twin","Shiro Games","Sloclap","Dotemu",
"The Game Bakers","Midgar Studio","DigixArt","Old Skull Games","Plug In Digital",
"Dear Villagers","Goblinz Studio","Pastagames","Leikir Studio","Eugen Systems",
"Microids","Bigben Interactive","Gameloft SE","Ubisoft Montpellier",
"Ubisoft Paris","Ubisoft Annecy","Ubisoft Bordeaux","Ubisoft Ivory Tower",
"Ubisoft Nadeo","Compagnie des Alpes","Puy du Fou","Futuroscope",
"Disneyland Paris","Groupe Partouche","Groupe Lucien Barrière",
"Française des Jeux","PMU","Betclic","Winamax")

# Consulting / IT Services
A("Capgemini SA","Sopra Steria Group","Alten","Assystem","Devoteam","Wavestone SA",
"Sia Partners","Mazars","Keyrus","Aubay","Neurones","Econocom France",
"Accenture France","Deloitte France","EY France","KPMG France","PwC France",
"McKinsey France","BCG France","Bain France","Roland Berger France",
"Oliver Wyman France","CGI France","Inetum","Octo Technology","Zenika",
"Ippon Technologies","Theodo","Onepoint","Fabernovel","Xebia France",
"Smile Open Source","Hardis Group","Absys Cyborg","Klee Group",
"In Extenso","Fiducial","Grant Thornton France","BDO France","RSM France",
"Baker Tilly France","Crowe France","PKF France","Moore France",
"Arthur D. Little France","Simon-Kucher France","L.E.K. Consulting France",
"Kearney France","Strategy& France","AlixPartners France",
"FTI Consulting France","Alvarez & Marsal France",
"Spencer Stuart France","Egon Zehnder France","Korn Ferry France",
"Heidrick & Struggles France","Russell Reynolds France","Boyden France")

# Transport / Logistics
A("SNCF","SNCF Réseau","SNCF Voyageurs","RATP","Keolis","Transdev","CMA CGM",
"Bolloré Logistics","Geodis","XPO Logistics France","FM Logistic","ID Logistics",
"Stef","Air France-KLM","Air France","Transavia France","Corsair International",
"Getlink","Eurostar","Chronopost","Colissimo","DPD France","GLS France",
"Mondial Relay","Colis Privé","La Poste Group","Aéroports de Paris",
"Petit Forestier","Fraikin","Brittany Ferries","Corsica Ferries",
"Compagnie du Ponant","CroisiEurope","FlixBus France","Kuehne+Nagel France",
"DHL France","FedEx France","UPS France","Schenker France","DSV France",
"Dachser France","RATP Dev","Keolis SA","Transdev Group","Ouigo","Thalys",
"Air Corsica","Air Caraïbes","French Bee","Air Austral","Air Tahiti Nui",
"Europcar France","Hertz France","Sixt France","Enterprise France",
"Free2Move","Bolt France","Tier Mobility France","Lime France","Bird France")

# Real Estate
A("Gecina SA","Klépierre SA","Mercialys","Carmila","BNP Paribas Real Estate",
"CBRE France","JLL France","Cushman & Wakefield France","Savills France",
"Knight Frank France","Colliers France","Primonial REIM","La Française REM",
"Sofidy","Amundi Real Estate","AEW Europe","Hines France",
"Tishman Speyer France","Nexity SA FR","Icade SA")

# Legal
A("Gide Loyrette Nouel","Bredin Prat","Cleary Gottlieb France",
"Freshfields France","Linklaters France","Latham & Watkins France",
"White & Case France","Allen & Overy France","Baker McKenzie France",
"CMS Francis Lefebvre","DLA Piper France","Dentons France",
"Clifford Chance France","Fidal","August Debouzy","Darrois Villey Maillot",
"De Pardieu Brocas Maffei","Herbert Smith Freehills France",
"Hogan Lovells France","Jones Day France","Skadden France",
"Kirkland & Ellis France","Gibson Dunn France","Quinn Emanuel France",
"Willkie Farr France","Racine Avocats","Jeantet Associés",
"Shearman & Sterling France","Sullivan & Cromwell France","Weil Gotshal France",
"Goodwin France","Paul Hastings France","Morgan Lewis France",
"Reed Smith France","Simmons & Simmons France","Osborne Clarke France",
"Bird & Bird France","Taylor Wessing France","Fieldfisher France",
"Pinsent Masons France","Mayer Brown France","Debevoise France",
"Davis Polk France","Cravath France","Milbank France",
"Simpson Thacher France","Paul Weiss France")

# Hospitality
A("AccorHotels","Sofitel","Pullman Hotels","Novotel","Mercure Hotels","Ibis Hotels",
"Mama Shelter","Groupe Barrière","Ritz Paris","Le Bristol Paris","Club Med",
"Pierre & Vacances","Center Parcs France","Louvre Hotels Group",
"B&B Hotels France","Première Classe","Campanile","Kyriad",
"Four Seasons George V","Plaza Athénée","Le Meurice","Mandarin Oriental Paris",
"Park Hyatt Paris","Shangri-La Paris","Peninsula Paris","Cheval Blanc Paris",
"Hôtel de Crillon","Marriott France","Hilton France","Hyatt France",
"Radisson France","IHG France","Best Western France","Adagio Aparthotels",
"Appart'City","WeWork France","Wojo","Morning Coworking","Kwerk",
"Spaces France","Regus France")

# Cosmetics extended
A("L'Oréal Paris","Lancôme","Garnier","Maybelline","Kérastase","Shu Uemura France",
"Helena Rubinstein","Biotherm","IT Cosmetics France","Urban Decay France",
"NYX Professional Makeup France","CeraVe France","Phyto Paris","René Furterer",
"Ducray","Naos Group","Institut Esthederm","Melvita","Cattier Paris",
"Weleda France","Atelier Cologne","Byredo France","Le Labo France",
"Frédéric Malle","Annick Goutal","Comptoir Sud Pacifique","Interparfums SA",
"Estée Lauder France","Shiseido France","Kao France","Coty France",
"Procter & Gamble France","Henkel France","Beiersdorf France",
"Colgate-Palmolive France","Johnson & Johnson France","Reckitt France",
"SC Johnson France","Church & Dwight France")

# Staffing / HR
A("Adecco France","Randstad France","ManpowerGroup France","Synergie","Crit",
"Hays France","Michael Page France","Robert Half France","Robert Walters France",
"Spring Professional","Expectra","Groupe Actual","Proman","Adequat","Partnaire",
"Domino RH","Temporis","Samsic Emploi","LHH France","Gi Group France",
"Page Personnel France","Badenoch & Clark France")

# Cleantech / Waste
A("Veolia SA","Suez SA","Séché Environnement SA","Paprec Group","Derichebourg SA",
"Saur","Nicollin","Ortec Group","Pizzorno Environnement","Veolia Propreté",
"Suez Recyclage","Paprec Recyclage","Chimirec","GDE Recyclage")

# Security / Facility Management
A("Idemia","Securitas France","Loomis France","Brinks France","IN Groupe",
"Assa Abloy France","Dormakaba France","Verisure France","Onet","Samsic","GSF",
"Atalian","ISS France","Elior Services")

# Food service
A("Sodexo SA","Elior Group SA","Compass Group France","Newrest France",
"API Restauration","Big Mamma Group","Paris Society","Alain Ducasse Entreprise",
"Buffalo Grill","Hippopotamus","Courtepaille","Flunch","O'Tacos","Cojean",
"McDonald's France","Burger King France","KFC France","Subway France",
"Domino's Pizza France","Starbucks France","Five Guys France","Quick France")

# IT / Software
A("IBM France","Oracle France","Microsoft France","Google France",
"Amazon Web Services France","Salesforce France","SAP France",
"ServiceNow France","Dell Technologies France","HPE France","VMware France",
"Nutanix France","Workday France","Sage France","Dassault Systèmes SE","Esker",
"Generix Group","Itesoft","Sidetrade","Visiativ","Neocase Software","Lucca",
"Bodet Software","Cegid SA","Axway Software","Ateme","Verimatrix","Kalray",
"SES-imagotag","Prodways Group","Lectra SA","Datadog France","Elastic France",
"Snowflake France","Databricks France","Confluent France","GitLab France",
"Snyk France","CrowdStrike France","Palo Alto Networks France","Fortinet France",
"Check Point France","Cloudflare France","Akamai France","Sophos France",
"Trend Micro France","Kaspersky France","Bitdefender France","ESET France",
"Stormshield","Tehtris","Sekoia","CrowdSec","Vade Secure","Centreon",
"BonitaSoft","Rudder","Jahia","Zendesk France","Freshworks France",
"HubSpot France","Slack France","Zoom France","Monday.com France",
"Asana France","Notion France")

# Engineering consulting
A("Egis","Artelia","Systra","Segula Technologies","Expleo","Altran",
"Bertrandt France","AKKA Technologies","Assystem SA","Alten SA","Setec Group",
"Tractebel France","Arcadis France","WSP France","Arup France","Ramboll France",
"Sweco France","Mott MacDonald France")

# Industrial
A("Schneider Electric SE","Legrand SA","Fives Group","Sidel Group","Verallia",
"SEB Group","Tefal","Moulinex","Rowenta","Calor","BIC","Somfy","Parrot",
"Devialet","Focal","L-Acoustics","Digigram","Groupe Atlantic","Exel Industries",
"Precia Molen","Tivoly","Aurea","Riber","Otis France","Schindler France",
"ThyssenKrupp France","Kone France","Daikin France","Carrier France",
"Johnson Controls France","Viessmann France","De Dietrich Thermique",
"Saunier Duval","Vaillant France","Frisquet","Atlantic Climatisation",
"Grohe France","Hansgrohe France","Geberit France","Villeroy & Boch France",
"Hilti France","Makita France","DeWalt France","Milwaukee France",
"Bosch Professional France","Facom","Stanley France","Husqvarna France",
"Stihl France","Sonepar France","Rexel France","AkzoNobel France",
"PPG France","Sherwin-Williams France","Tollens","V33",
"Samsung France","LG France","Sony France","Panasonic France","Philips France",
"Dyson France","Miele France","Liebherr France","Bosch Electroménager France",
"Siemens Home France","Whirlpool France","Electrolux France","Smeg France",
"Le Creuset","Staub","Cristel","De Buyer","Mauviel","Magimix","Robot-Coupe",
"Thermomix France","Vorwerk France","Poclain Hydraulics","Manitou BF",
"Haulotte","Pellenc","Stäubli France","Parker Hannifin France",
"Emerson France","Honeywell France","Danfoss France","Eaton France",
"ABB France","Siemens France","Fives Cail","Fives Cryo","Fives Nordon",
"Fives Stein","Fives Cinetic","Fives DMS","Fives ECL","Fives FCB",
"Nexo","Cabasse","Elipson","Devialet SA","Focal JMlab","Parrot SA","Parrot Drones",
"Sagemcom","Technicolor","SoftAtHome")

# Chemicals / Materials
A("Arkema SA","Solvay France","Rhodia","Bostik","SNF Group","Kem One","Adisseo",
"Nouryon France","Chryso","BASF France","Dow France","DuPont France","3M France",
"Henkel France SA","Eramet SA","Imerys SA","Constellium","Aperam France",
"Aubert & Duval","Vallourec SA","Lisi Group","Mersen SA")

# Data centers
A("Equinix France","Interxion France","Data4 Group","Global Switch France",
"Telehouse France","Etix Everywhere","Scaleway Datacenter")

# Education
A("Ionis Education Group","Galileo Global Education","ESSEC Business School",
"HEC Paris","INSEAD","ESCP Business School","EDHEC Business School",
"Emlyon Business School","Kedge Business School","Skema Business School",
"Neoma Business School","Audencia Business School","Epitech","EPITA","EFREI Paris",
"CentraleSupélec","École Polytechnique","Mines ParisTech","TBS Education",
"ICN Business School","EM Normandie","IESEG School","ISG Paris","EDC Paris")

# Sports
A("Rossignol","Salomon","Petzl","Millet","Lafuma","Babolat","Mavic","Look Cycle",
"Decathlon SA","Paris Saint-Germain","Olympique de Marseille","Olympique Lyonnais",
"AS Monaco FC","LOSC Lille","Stade Rennais","RC Lens","OGC Nice","RC Strasbourg",
"Stade Toulousain","ASM Clermont Auvergne","Racing 92","Stade Français Paris",
"Quechua","Tribord","Domyos","Kalenji","B'Twin","Kipsta","Black Crows","Fusalp",
"Oxbow","Rossignol Group","Dynastar","Fusalp SA")

# Advertising / Digital agencies
A("BETC","DDB Paris","TBWA Paris","Publicis Conseil","Ogilvy Paris","Havas Paris",
"Fred & Farid","Leo Burnett Paris","Saatchi & Saatchi France","Dentsu France",
"Marcel Agency","Publicis Sapient France","Razorfish France","Digitas France",
"GroupM France","Mindshare France","MediaCom France","Wavemaker France",
"Carat France","iProspect France","Zenith France","Starcom France","OMD France",
"PHD France","Ipsos","OpinionWay","BVA Group","Ifop","Kantar France")

# Testing / Certification
A("Bureau Veritas SA","Apave","Socotec","Dekra France","Intertek France",
"Eurofins Scientific SE","Mérieux NutriSciences","SGS France","Ecocert","Afnor",
"TÜV Rheinland France","DNV France","Lloyd's Register France")

# Misc notable
A("Groupe SOS","OGF","Roc Eclerc","Funecap","Alliance Healthcare France",
"OCP Répartition","Phoenix Pharma France","Welcoop","GL Events","Comexposium",
"Viparis","Hopscotch Groupe","BYmyCAR","Jean Lain Automobiles",
"Median Technologies","Voluntis","Biocorp")

# Pharmacy / Optical
A("Alliance Healthcare","OCP","Phoenix Pharma","CERP Rouen",
"Optic 2000 SA","Krys","Atol SA","Afflelou SA","GrandVision","Optical Center SA")

# Events / Tourism
A("GL Events SA","Reed Expositions","Comexposium SA","Viparis SA",
"Hopscotch SA","Club Med SA","Pierre & Vacances SA","Huttopia","Capfun",
"Yelloh Village","Sandaya","Homair Vacances","Belambra Clubs")

ct = sum(1 for x in lines if not x.startswith("#"))
print(f"France total unique companies: {ct}")

###############################################################################
# Save France, then we'll generate remaining countries in separate script
###############################################################################
with open(OUT, 'w', encoding='utf-8') as f:
    for line in lines:
        f.write(line + "\n")

# Save state
import json
with open('/tmp/eu_seen.json','w') as f:
    json.dump(list(seen), f)
with open('/tmp/eu_count.txt','w') as f:
    f.write(str(ct))

print("France section saved.")
