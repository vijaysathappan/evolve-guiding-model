/**
 * First-boot seeder — populates the local datastore with:
 *  - live exam news (Home mode feed)
 *  - NCERT-aligned curriculum chapters (Learn mode + the RAG index)
 * Runs only when the corresponding tables are empty.
 */
import { table, saveNow } from './db.js';

const NEWS = [
  { title: 'JEE Main 2027 Session 1 registration window announced', category: 'JEE', summary: 'NTA has opened the registration window for JEE Main Session 1. Candidates should complete applications early and verify category certificates before the deadline. Late fees apply in the final 48 hours.', source_url: 'https://jeemain.nta.nic.in', published_at: '2026-07-10' },
  { title: 'NEET UG counselling round 2 seat allotment released', category: 'NEET', summary: 'MCC has published the round-2 seat allotment for NEET UG counselling. Allotted candidates must report to their institutes with original documents within the reporting window.', source_url: 'https://mcc.nic.in', published_at: '2026-07-12' },
  { title: 'CBSE announces revised Class 12 practical exam schedule', category: 'CBSE', summary: 'The board has shifted practical examinations two weeks later to align with the revised theory datesheet. Schools must upload internal marks by the new deadline.', source_url: 'https://cbse.gov.in', published_at: '2026-07-08' },
  { title: 'JEE Advanced 2026 syllabus: no changes confirmed by IIT organizing institute', category: 'JEE', summary: 'The organizing IIT confirmed the JEE Advanced syllabus remains identical to last year, ending speculation about the removal of some Modern Physics topics.', source_url: 'https://jeeadv.ac.in', published_at: '2026-07-05' },
  { title: 'NTA introduces stricter biometric verification at exam centres', category: 'JEE', summary: 'From the next session, all NTA exams will use dual biometric verification (fingerprint + face). Candidates should arrive 90 minutes early to avoid queue delays.', source_url: 'https://nta.ac.in', published_at: '2026-07-03' },
  { title: 'NEET 2027 to continue in pen-and-paper mode, NMC confirms', category: 'NEET', summary: 'The National Medical Commission confirmed NEET UG will remain an offline OMR-based exam next year, with an increased number of exam cities.', source_url: 'https://nmc.org.in', published_at: '2026-06-30' },
  { title: 'CBSE launches free doubt-resolution portal for Class 11-12 science students', category: 'CBSE', summary: 'The board launched an online portal where students can post subject doubts answered by empanelled teachers within 24 hours. Registration uses the school UDISE code.', source_url: 'https://cbse.gov.in', published_at: '2026-06-28' },
  { title: 'Scholarship: KVPY-successor "Vigyan Pratibha" applications open', category: 'JEE', summary: 'Applications are open for the national science fellowship for Class 11/12 students. Selection is via aptitude test plus interview; fellows receive monthly stipends through UG studies.', source_url: 'https://online-fellowship.in', published_at: '2026-06-25' },
  { title: 'AIIMS adds 400 MBBS seats across new campuses', category: 'NEET', summary: 'Four new AIIMS campuses received Letters of Permission adding ~400 MBBS seats to the NEET UG pool, improving competitive ratios for this cycle.', source_url: 'https://aiimsexams.ac.in', published_at: '2026-06-22' },
  { title: 'Physics practicals weightage clarified for CBSE 2027 boards', category: 'CBSE', summary: 'CBSE clarified that Physics practicals remain 30 marks with 70 theory. Record work and viva carry mandatory minimums — students must not skip practical classes.', source_url: 'https://cbse.gov.in', published_at: '2026-06-20' },
  { title: 'JEE Main to allow section-wise review screen in CBT interface', category: 'JEE', summary: 'NTA is upgrading the computer-based-test interface with a section-wise answer review screen before final submission, reducing accidental unanswered questions.', source_url: 'https://jeemain.nta.nic.in', published_at: '2026-06-18' },
  { title: 'NEET biology: NCERT releases errata affecting 6 textbook pages', category: 'NEET', summary: 'NCERT published corrections to the Class 12 Biology textbook (genetics and ecology chapters). NEET aspirants should download the errata since NTA sources questions from the corrected text.', source_url: 'https://ncert.nic.in', published_at: '2026-06-15' },
];

// Curriculum content — NCERT-aligned summaries written for the local RAG index.
const CHAPTERS = [
  {
    subject: 'Physics',
    class_level: 'Class 11',
    chapter_name: 'Units and Measurement',
    order_index: 1,
    pyq_weightage: 'high',
    sections: [
      {
        title: '1.1 The International System of Units',
        raw_text: `Measurement of any physical quantity involves comparison with a certain basic, arbitrarily chosen, internationally accepted reference standard called a unit. The result of a measurement is expressed by a number accompanied by a unit.\n\nThe International System of Units (SI) is based on seven base units: metre (length), kilogram (mass), second (time), ampere (electric current), kelvin (temperature), mole (amount of substance) and candela (luminous intensity). All other physical quantities are expressed in derived units, which are combinations of the base units — for example, the unit of force is kg·m/s², named the newton (N).\n\nSince 2019 all SI base units are defined through fixed values of fundamental constants: the second through the caesium transition frequency, the metre through the speed of light c = 299,792,458 m/s, and the kilogram through Planck's constant h = 6.626 × 10⁻³⁴ J·s. This makes the standards reproducible in any laboratory rather than depending on physical artefacts.`,
      },
      {
        title: '1.2 Significant Figures',
        raw_text: `Every measurement has a limited precision, and the reported result should reflect it. Significant figures are the reliable digits plus the first uncertain digit in a measured value. For example, a length reported as 2.308 cm has four significant figures.\n\nRules: all non-zero digits are significant; zeros between non-zero digits are significant; leading zeros are never significant (0.0023 has two significant figures); trailing zeros are significant only if the number contains a decimal point (2.500 has four, but 2500 is ambiguous and is best written in scientific notation as 2.5 × 10³).\n\nIn multiplication or division the result keeps as many significant figures as the least precise measurement. In addition or subtraction the result keeps as many decimal places as the term with the fewest decimal places. Rounding follows the usual convention: if the dropped digit is 5, round to the nearest even digit.`,
      },
      {
        title: '1.3 Dimensions of Physical Quantities',
        raw_text: `The dimensions of a physical quantity are the powers to which the base quantities are raised to represent that quantity. Using symbols [M], [L], [T], [A], [K] for mass, length, time, current and temperature, velocity has dimensions [L T⁻¹], acceleration [L T⁻²], force [M L T⁻²], work and energy [M L² T⁻²], and pressure [M L⁻¹ T⁻²].\n\nDimensional analysis serves three purposes. First, checking dimensional consistency: an equation must have the same dimensions on both sides — the principle of homogeneity. In v² = u² + 2as every term has dimensions [L² T⁻²], so the equation is dimensionally consistent.\n\nSecond, deducing relations among physical quantities: the time period of a simple pendulum can be shown to be proportional to √(l/g) purely by dimensional reasoning. Third, converting units between systems. Limitations: dimensional analysis cannot determine dimensionless constants (like the 2π in the pendulum formula), cannot handle trigonometric or exponential functions, and cannot distinguish quantities with identical dimensions such as work and torque.`,
      },
      {
        title: '1.4 Errors in Measurement',
        raw_text: `The uncertainty in a measurement is called error. Systematic errors bias the result in one direction — instrumental errors (zero error of a vernier), imperfect experimental technique, and personal errors. Random errors fluctuate irregularly and are reduced by repeating observations and taking the arithmetic mean.\n\nAbsolute error is |measured value − true value| (the mean is taken as the true value). Mean absolute error Δa is the average of the absolute errors. Relative error = Δa / a, and percentage error = (Δa / a) × 100%.\n\nCombination of errors: when quantities are added or subtracted, absolute errors add: ΔZ = ΔA + ΔB. When multiplied or divided, relative errors add: ΔZ/Z = ΔA/A + ΔB/B. For a power Z = Aⁿ, ΔZ/Z = n·(ΔA/A). This is why quantities raised to high powers in a formula must be measured most precisely — a JEE favourite.`,
      },
    ],
  },
  {
    subject: 'Physics',
    class_level: 'Class 11',
    chapter_name: 'Motion in a Straight Line',
    order_index: 2,
    pyq_weightage: 'high',
    sections: [
      {
        title: '2.1 Position, Displacement and Distance',
        raw_text: `Motion is a change in position of an object with time, described relative to a chosen origin and axis. For motion along a straight line (rectilinear motion), position is the coordinate x of the object.\n\nDistance is the total path length covered and is a scalar — always positive. Displacement is the change in position, Δx = x₂ − x₁, and is a vector — it can be positive, negative or zero. The magnitude of displacement is never greater than the distance travelled; they are equal only when motion is in one fixed direction without reversal.\n\nExample: a particle moving from x = 0 to x = 10 m and back to x = 4 m travels a distance of 16 m but its displacement is only +4 m.`,
      },
      {
        title: '2.2 Average and Instantaneous Velocity',
        raw_text: `Average speed = total distance / total time; average velocity = displacement / time interval. Average speed is greater than or equal to the magnitude of average velocity.\n\nInstantaneous velocity is the limit of the average velocity as the time interval shrinks to zero: v = dx/dt, the derivative of position with respect to time. Graphically it is the slope of the tangent to the position-time graph at that instant.\n\nA common misconception is confusing average velocity with the average of initial and final velocities — that shortcut is valid only for uniform acceleration. For a body covering two equal distances at speeds v₁ and v₂, the average speed is the harmonic mean 2v₁v₂/(v₁+v₂), not the arithmetic mean.`,
      },
      {
        title: '2.3 Acceleration and Kinematic Equations',
        raw_text: `Acceleration is the rate of change of velocity: a = dv/dt = d²x/dt². On a velocity-time graph, acceleration is the slope, and the area under the graph gives displacement.\n\nFor uniform (constant) acceleration the kinematic equations hold: v = u + at; s = ut + ½at²; v² = u² + 2as; and displacement in the nth second, sₙ = u + a(2n−1)/2. Here u is initial velocity, v final velocity, s displacement.\n\nThese equations are derivable from calculus or from the v-t graph. They apply ONLY when acceleration is constant — a frequent exam trap is applying them to non-uniform acceleration. For variable acceleration, integrate: v = ∫a dt and x = ∫v dt.`,
      },
      {
        title: '2.4 Free Fall and Relative Velocity',
        raw_text: `Free fall is motion under gravity alone, with constant acceleration g ≈ 9.8 m/s² directed downward, independent of the mass of the body (Galileo's result). Taking upward as positive, a = −g. For a body dropped from rest: v = gt, h = ½gt², v² = 2gh.\n\nFor a body thrown upward with speed u: time to reach highest point t = u/g, maximum height H = u²/2g, and total time of flight 2u/g. Velocity is zero at the top but acceleration remains g — a classic conceptual question.\n\nRelative velocity in one dimension: the velocity of A relative to B is v_AB = v_A − v_B. Two trains moving in the same direction close at the difference of speeds; in opposite directions they close at the sum. Rain-man and river-boat problems build directly on this idea.`,
      },
    ],
  },
  {
    subject: 'Chemistry',
    class_level: 'Class 11',
    chapter_name: 'Some Basic Concepts of Chemistry',
    order_index: 1,
    pyq_weightage: 'high',
    sections: [
      {
        title: '1.1 Laws of Chemical Combination',
        raw_text: `Antoine Lavoisier's law of conservation of mass states that matter is neither created nor destroyed in a chemical reaction. Proust's law of definite proportions states that a given compound always contains exactly the same proportion of elements by weight.\n\nDalton's law of multiple proportions: when two elements combine to form more than one compound, the masses of one element combining with a fixed mass of the other are in ratios of small whole numbers — for example, in CO and CO₂, the oxygen masses per fixed carbon are in the ratio 1:2.\n\nGay-Lussac's law of gaseous volumes and Avogadro's hypothesis (equal volumes of gases at the same temperature and pressure contain equal numbers of molecules) complete the classical foundation on which Dalton's atomic theory rests.`,
      },
      {
        title: '1.2 Mole Concept and Molar Mass',
        raw_text: `One mole is the amount of substance containing exactly 6.02214076 × 10²³ elementary entities — the Avogadro constant N_A. The molar mass of a substance is the mass of one mole of it in grams, numerically equal to its atomic or molecular mass in unified mass units (u).\n\nKey conversions: number of moles n = given mass / molar mass = number of particles / N_A = volume of gas at STP / 22.4 L (for ideal gases at old STP; 22.7 L at the new 1-bar STP convention).\n\nMolarity M = moles of solute per litre of solution; molality m = moles of solute per kilogram of solvent; mole fraction x_A = n_A / (n_A + n_B). Molality and mole fraction are temperature-independent because they involve masses, while molarity changes with temperature since solution volume expands.`,
      },
      {
        title: '1.3 Stoichiometry and Limiting Reagent',
        raw_text: `A balanced chemical equation gives the mole ratios in which substances react and form. Stoichiometric calculations convert between mass, moles and volume using these ratios.\n\nThe limiting reagent is the reactant completely consumed first; it determines the maximum product formed. To identify it, divide the available moles of each reactant by its stoichiometric coefficient — the smallest quotient marks the limiting reagent. All yield calculations must be based on the limiting reagent, never the excess one.\n\nPercentage yield = (actual yield / theoretical yield) × 100. Percentage purity problems reverse the logic: only the pure fraction of a sample takes part in the reaction. These two patterns cover most JEE/NEET stoichiometry questions.`,
      },
      {
        title: '1.4 Empirical and Molecular Formula',
        raw_text: `The empirical formula gives the simplest whole-number ratio of atoms of each element in a compound; the molecular formula gives the actual number of atoms per molecule. Molecular formula = (empirical formula) × n where n = molar mass / empirical formula mass.\n\nTo find the empirical formula from percentage composition: assume 100 g of compound, convert each element's mass to moles, divide by the smallest mole number, and clear fractions to whole numbers.\n\nExample: a compound with 40% C, 6.7% H and 53.3% O gives mole ratios C : H : O = 3.33 : 6.7 : 3.33 = 1 : 2 : 1, so the empirical formula is CH₂O. If the molar mass is 180 g/mol, n = 180/30 = 6 and the molecular formula is C₆H₁₂O₆ — glucose.`,
      },
    ],
  },
  {
    subject: 'Mathematics',
    class_level: 'Class 11',
    chapter_name: 'Sets and Functions',
    order_index: 1,
    pyq_weightage: 'medium',
    sections: [
      {
        title: '1.1 Sets and Their Representation',
        raw_text: `A set is a well-defined collection of distinct objects. Sets are written in roster form, listing elements as in A = {1, 2, 3}, or set-builder form, as in A = {x : x is a natural number less than 4}.\n\nStandard sets: N (naturals), Z (integers), Q (rationals), R (reals). The empty set ∅ contains no elements; a singleton has exactly one. A set is finite if it has a definite number of elements, otherwise infinite.\n\nSet A is a subset of B (A ⊆ B) if every element of A is in B. The power set P(A) is the set of all subsets of A; if A has n elements, P(A) has 2ⁿ elements — a fact tested constantly in exams. Intervals are subsets of R: [a, b] closed, (a, b) open.`,
      },
      {
        title: '1.2 Set Operations and Venn Diagrams',
        raw_text: `Union A ∪ B contains elements in either set; intersection A ∩ B contains elements in both; difference A − B contains elements of A not in B; complement A′ = U − A relative to a universal set U.\n\nDe Morgan's laws: (A ∪ B)′ = A′ ∩ B′ and (A ∩ B)′ = A′ ∪ B′. Distributive laws: A ∩ (B ∪ C) = (A ∩ B) ∪ (A ∩ C) and the dual with ∪ over ∩.\n\nThe inclusion-exclusion principle for counting: n(A ∪ B) = n(A) + n(B) − n(A ∩ B), extended to three sets as n(A ∪ B ∪ C) = Σn(A) − Σn(A ∩ B) + n(A ∩ B ∩ C). Survey-type word problems ("how many students play both cricket and football") are direct applications.`,
      },
      {
        title: '1.3 Relations and Functions',
        raw_text: `The Cartesian product A × B is the set of ordered pairs (a, b) with a ∈ A, b ∈ B; if n(A) = p and n(B) = q then n(A × B) = pq. A relation from A to B is any subset of A × B; the number of possible relations is 2^(pq).\n\nA function f : A → B assigns each element of A exactly one element of B. A is the domain, B the codomain, and the set of actual outputs is the range (range ⊆ codomain).\n\nImportant real functions and their domains: identity, constant, polynomial, rational (denominator ≠ 0), modulus |x|, signum, and greatest integer [x]. Algebra of functions: (f ± g)(x), (fg)(x), (f/g)(x) with g(x) ≠ 0. Finding domain and range of composed expressions like √(4 − x²) is a standard exam skill: here the domain is [−2, 2] and the range [0, 2].`,
      },
    ],
  },
];

export function seed() {
  const news = table('news');
  if (news.count() === 0) {
    NEWS.forEach(n => news.insert({ ...n, relevance_score: Math.floor(60 + Math.random() * 40) }));
    console.log(`[SEED] Inserted ${NEWS.length} news items`);
  }
  const chapters = table('learn_chapters');
  if (chapters.count() === 0) {
    CHAPTERS.forEach(c => chapters.insert(c));
    console.log(`[SEED] Inserted ${CHAPTERS.length} curriculum chapters`);
  }
  saveNow();
}

export default seed;
