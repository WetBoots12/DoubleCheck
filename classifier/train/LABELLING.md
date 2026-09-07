# Labelling guide for the Wikinews sentences

The Wikinews sentences in `data/wikinews.csv` are labelled by the ClaimBuster
scheme, so that they can be trained on together with the ClaimBuster data without
the two disagreeing about what the label means. The definitions, the examples and
the rules below are the ones the ClaimBuster annotators were given, taken from
Arslan, Hassan, Li and Tremayne, *A Benchmark Dataset of Check-worthy Factual
Claims* (ICWSM 2020), section 4.1 and Table 1, and from Hassan, Li and Tremayne,
*Detecting Check-worthy Factual Claims in Presidential Debates* (CIKM 2015),
section 2. Where the guide had to be applied to news prose rather than debate
speech, the adaptation is stated as such and kept as small as possible.

## The three classes

Each sentence gets exactly one of three labels. The `Verdict` column uses
ClaimBuster's numbers: **1** for CFS, **0** for UFS, **-1** for NFS.

**Check-worthy Factual Sentence (CFS, 1).** In the authors' words: these sentences
contain factual claims that the general public will be interested in learning about
their veracity. Journalists look for these types of claims for fact-checking. Their
examples:

- In the last month, we've had a net loss of one hundred and sixty-three thousand jobs.
- We've spent $4.7 billion a year in the State of Texas for uninsured people.
- When they tried to reduce taxes, he voted against that 127 times.
- China and India are graduating more graduates in technology and science than we are.
- My opponent opposed the missile defenses.
- He voted against the first Gulf War.
- Over a million and a quarter Americans are HIV-positive.

**Unimportant Factual Sentence (UFS, 0).** These are factual claims but not
check-worthy. In other words, the general public will not be interested in knowing
whether these sentences are true or false. Fact-checkers do not find these
sentences significant for checking. Their examples:

- I am a son of a Methodist minister.
- Just yesterday, I was in Toledo shaking some hands in a line.
- Well, the Vice President and I came to the Congress together 1946; we both served in the Labor Committee.
- And I've got two daughters and I want to make sure that they have the same opportunities that anybody's sons have.
- Next Tuesday is Election Day.
- Two days ago we ate lunch at a restaurant.

**Non-factual Sentence (NFS, -1).** These sentences do not contain any factual
claims. Subjective sentences (opinions, beliefs, declarations) and many questions
fall under this category. Their examples:

- The worst thing we could do in this economic climate is to raise people's taxes.
- I think the Head Start program is a great program.
- We need to cut the business tax rate in America.
- I'll get America and North America energy independent.
- But I think it's time to talk about the future.
- You remember the last time you said that?

## The explanations the annotators were trained on

ClaimBuster trained every annotator on forty sentences with an expert explanation
for each. The explanations in the paper's Table 1 are the closest thing to a rule
book, and they settle most of the hard cases:

| Sentence | Label | Explanation given |
|---|---|---|
| Well, you know, nailing down Senator Obama's various tax proposals is like nailing Jell-O to the wall. | NFS | Does not contain any factual information. It is a rhetorical expression. |
| I'm simply not going to do that. | NFS | The speaker is making a promise and/or talking about his/her future plan. |
| In addition to that, we've suffered because we haven't had leadership in this administration. | NFS | It is about the speaker's opinion or position on a certain topic. |
| I was Governor of Georgia for four years. | UFS | Contains factual information. However, the general public would not be interested in checking the presented factual claim. |
| In Puerto Rico this year, I met with six of the leading industrial nations' heads of state to meet the problem of inflation... | UFS | Contains factual information, but the public would not be interested in checking it. |
| But first of all, this is a nation of immigrants. | UFS | Contains factual information, but the public would not be interested in checking it. |
| I think everybody understands at this point that we are experiencing the worst financial crisis since the Great Depression. | CFS | Contains both opinions and factual information. The factual information is worthy of veracity checking. |
| Government spending has gone completely out of control; $10 trillion dollar debt we're giving to our kids, a half-a-trillion dollars we owe China. | CFS | Presenting data with a quantity. People in general would be interested to know whether the quantity is correct or not. |
| In the first place I've never suggested that Cuba was lost except for the present. | CFS | A factual claim regarding a past incident. People in general would be interested to know whether the statement is true or false. |

Three rules follow from these and are applied here exactly as stated:

1. **Opinion mixed with a checkable fact is CFS.** "I think" does not disqualify a
   sentence when what follows is a factual claim the public would want checked.
2. **A quantity the public would care about is CFS.** Figures, counts, amounts,
   dates of consequence.
3. **A claim about a past event is CFS** when the public would want to know whether
   it is true, even without a number.

And on the other side:

4. **Promises, plans, predictions and intentions are NFS.** "Will" and "going to"
   about the speaker's own future action carry no factual claim.
5. **Opinions, positions, evaluations and rhetoric are NFS**, as are most questions.
6. **Facts nobody would bother to check are UFS.** Personal biography, where the
   speaker was yesterday, what day the election is.

## What ClaimBuster did before labelling, and the equivalent here

- They kept only sentences spoken by the candidates; moderators, questioners and
  announcers were discarded rather than labelled. The equivalent for a news
  article is to label only the article body. Datelines, bylines, headings, source
  lists, "related news" lists and editorial notes are discarded, not labelled.
- They removed sentences shorter than five words. The same cut is applied here.
- Ground truth came from three experts agreeing, and crowd labels were accepted
  only from participants who agreed with the experts on hidden screening sentences.
  There is one labeller here. The compensation is that this guide is written down,
  every label can be traced to a rule above, and a sample is spot-checked by a
  second person before training.

## Applying the guide to news prose: the adaptations

Debate sentences are first person; news sentences are third person and attributed.
Two adaptations were needed, both in the spirit of the explanations above.

**Reported claims.** "The minister said unemployment fell to 4.2 percent" contains
a factual claim about the world, attributed to someone. The label follows the
content of what is reported, exactly as the Table 1 explanation labels "I think
everybody understands... the worst financial crisis since the Great Depression" a
CFS despite the framing. So a reported figure or event is CFS. A reported opinion,
"the minister said the plan was a disgrace", is NFS, because what is reported is an
opinion; the only fact in it, that the minister said it, is not what the public
would want checked. A reported promise or plan is NFS by rule 4.

**The reporter's own narrative.** News prose contains sentences that are factual
but that no one would check: the weather at the march, that a spokesman declined
to comment, that a hearing is scheduled to continue. These are UFS by rule 6.
Scene-setting with no factual content, and the reporter's characterisations, are
NFS by rule 5.

Sports results and standings that are stated as facts in an article body, "the
Senators beat the Bruins 4-2", are factual and are labelled on the public-interest
test like anything else: a result, a record or a scoreline in a story is UFS or
CFS by whether readers would want it checked, not NFS.

## How the labels are used

Only CFS becomes a positive training label; UFS and NFS are both negatives, since an
unimportant fact is not worth a search call either. This is how `prepare_data.py`
already treats ClaimBuster's verdicts, and the Wikinews file goes through the same
mapping with `domain` set to `wikinews`, so `train.py` reports it separately.
