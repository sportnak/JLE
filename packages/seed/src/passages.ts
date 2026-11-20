import type { LibraryPassage } from '@jle/engine';

/**
 * Built-in reading passages for when there is no model (no key, no network, or a failed run). Written for this app,
 * graded by level: 1 is the first weeks (です, これ, nouns), 2 adds verbs in ます form, 3 the past tense and adjectives,
 * 4 て-forms, たい and reasons, 5 rounds out N5, 6 reaches toward N4. The engine picks whichever fits the learner best,
 * so level only breaks ties. Plain polite style throughout; no romaji, no furigana (the reader adds it).
 */
export const LIBRARY: LibraryPassage[] = [
  // Level 1
  { id: 'l1-01', level: 1, title: '私の本', text: 'これは私の本です。それは先生の本です。', translation: 'This is my book. That is the teacher’s book.' },
  { id: 'l1-02', level: 1, title: '学生', text: '私は学生です。友達も学生です。先生は日本人です。', translation: 'I am a student. My friend is a student too. The teacher is Japanese.' },
  { id: 'l1-03', level: 1, title: 'これは何ですか', text: 'これは何ですか。それは水です。あれはお茶です。', translation: 'What is this? That is water. That over there is tea.' },
  { id: 'l1-04', level: 1, title: '名前', text: 'はじめまして。私の名前は田中です。学生です。どうぞよろしく。', translation: 'Nice to meet you. My name is Tanaka. I am a student. Pleased to meet you.' },
  { id: 'l1-05', level: 1, title: 'あの人', text: 'あの人は誰ですか。あの人は山田さんです。山田さんは先生です。', translation: 'Who is that person? That person is Mr. Yamada. Mr. Yamada is a teacher.' },
  { id: 'l1-06', level: 1, title: '今日', text: '今日は月曜日です。明日は火曜日です。', translation: 'Today is Monday. Tomorrow is Tuesday.' },
  { id: 'l1-07', level: 1, title: '駅', text: 'ここは駅です。あそこは学校です。私の家はあそこです。', translation: 'This is the station. Over there is the school. My house is over there.' },
  { id: 'l1-08', level: 1, title: '猫', text: 'これは猫です。私の猫です。名前はタマです。', translation: 'This is a cat. It is my cat. Its name is Tama.' },
  { id: 'l1-09', level: 1, title: 'お金', text: 'これは私のお金です。それは母のお金です。', translation: 'This is my money. That is my mother’s money.' },
  { id: 'l1-10', level: 1, title: 'コーヒー', text: 'これはコーヒーですか。いいえ、お茶です。', translation: 'Is this coffee? No, it is tea.' },

  // Level 2
  { id: 'l2-01', level: 2, title: '毎朝', text: '私は毎朝コーヒーを飲みます。パンを食べます。それから学校へ行きます。', translation: 'Every morning I drink coffee. I eat bread. Then I go to school.' },
  { id: 'l2-02', level: 2, title: '夜', text: '夜、テレビを見ます。本も読みます。十一時に寝ます。', translation: 'At night I watch TV. I also read books. I go to bed at eleven.' },
  { id: 'l2-03', level: 2, title: '友達', text: '友達は東京に住んでいます。毎日電車に乗ります。', translation: 'My friend lives in Tokyo. They take the train every day.' },
  { id: 'l2-04', level: 2, title: '日曜日', text: '日曜日は学校へ行きません。家で本を読みます。', translation: 'On Sundays I don’t go to school. I read books at home.' },
  { id: 'l2-05', level: 2, title: '手紙', text: '私は母に手紙を書きます。母は手紙を読みます。', translation: 'I write a letter to my mother. My mother reads the letter.' },
  { id: 'l2-06', level: 2, title: '昼ご飯', text: '昼ご飯は学校で食べます。魚と野菜を食べます。', translation: 'I eat lunch at school. I eat fish and vegetables.' },
  { id: 'l2-07', level: 2, title: '電話', text: '父は毎晩電話をします。私も父と話します。', translation: 'My father calls every evening. I talk with him too.' },
  { id: 'l2-08', level: 2, title: '店', text: '駅の近くに店があります。私はそこでパンを買います。', translation: 'There is a shop near the station. I buy bread there.' },
  { id: 'l2-09', level: 2, title: '犬', text: '私の家に犬がいます。犬は毎日公園へ行きます。', translation: 'There is a dog at my house. The dog goes to the park every day.' },
  { id: 'l2-10', level: 2, title: '日本語', text: '私は毎日日本語を勉強します。先生と日本語で話します。', translation: 'I study Japanese every day. I speak with my teacher in Japanese.' },

  // Level 3
  { id: 'l3-01', level: 3, title: '昨日', text: '昨日は雨でした。私は家にいました。映画を見ました。', translation: 'Yesterday it rained. I stayed at home. I watched a movie.' },
  { id: 'l3-02', level: 3, title: '新しい車', text: '父は新しい車を買いました。車は大きくて、白いです。', translation: 'My father bought a new car. The car is big and white.' },
  { id: 'l3-03', level: 3, title: '寒い朝', text: '今朝はとても寒かったです。私は熱いお茶を飲みました。', translation: 'This morning was very cold. I drank hot tea.' },
  { id: 'l3-04', level: 3, title: 'レストラン', text: '昨日、友達とレストランへ行きました。料理はおいしかったです。でも、高かったです。', translation: 'Yesterday I went to a restaurant with a friend. The food was delicious. But it was expensive.' },
  { id: 'l3-05', level: 3, title: '静かな町', text: '私の町は小さくて、静かです。山と川があります。', translation: 'My town is small and quiet. There are mountains and a river.' },
  { id: 'l3-06', level: 3, title: '忙しい一日', text: '今日は忙しかったです。朝から夜まで仕事をしました。', translation: 'Today was busy. I worked from morning until night.' },
  { id: 'l3-07', level: 3, title: '古い本', text: 'この本は古いです。でも、とても面白いです。', translation: 'This book is old. But it is very interesting.' },
  { id: 'l3-08', level: 3, title: '週末', text: '週末、私は山へ行きました。天気がよかったです。楽しかったです。', translation: 'On the weekend I went to the mountains. The weather was good. It was fun.' },
  { id: 'l3-09', level: 3, title: '元気な子供', text: '公園に子供がたくさんいました。みんな元気でした。', translation: 'There were a lot of children in the park. They were all lively.' },
  { id: 'l3-10', level: 3, title: '宿題', text: '昨日の宿題は難しかったです。私は友達に聞きました。', translation: 'Yesterday’s homework was difficult. I asked a friend.' },

  // Level 4
  { id: 'l4-01', level: 4, title: '朝の準備', text: '朝起きて、顔を洗います。それから、ご飯を食べて、学校へ行きます。', translation: 'I get up in the morning and wash my face. Then I eat breakfast and go to school.' },
  { id: 'l4-02', level: 4, title: '日本へ行きたい', text: '私は日本へ行きたいです。京都でお寺を見たいです。おいしい料理も食べたいです。', translation: 'I want to go to Japan. I want to see temples in Kyoto. I also want to eat good food.' },
  { id: 'l4-03', level: 4, title: '窓', text: '暑いですから、窓を開けてください。', translation: 'It’s hot, so please open the window.' },
  { id: 'l4-04', level: 4, title: '図書館', text: '図書館で本を読んでいます。図書館では静かにしてください。', translation: 'I am reading a book in the library. Please be quiet in the library.' },
  { id: 'l4-05', level: 4, title: '雨の日', text: '雨が降っていますから、今日は出かけません。家で音楽を聞いています。', translation: 'It is raining, so I am not going out today. I am listening to music at home.' },
  { id: 'l4-06', level: 4, title: '写真', text: 'この写真を見てください。私の家族です。右は兄で、左は妹です。', translation: 'Please look at this photo. It is my family. On the right is my older brother, and on the left is my younger sister.' },
  { id: 'l4-07', level: 4, title: '駅まで', text: 'まっすぐ行って、二つ目の角を右に曲がってください。駅はすぐそこです。', translation: 'Go straight and turn right at the second corner. The station is right there.' },
  { id: 'l4-08', level: 4, title: '買い物', text: 'スーパーへ行って、肉と野菜を買いました。それから、家で晩ご飯を作りました。', translation: 'I went to the supermarket and bought meat and vegetables. Then I made dinner at home.' },
  { id: 'l4-09', level: 4, title: 'パーティー', text: '土曜日にパーティーをします。友達もたくさん来ます。あなたも来てください。', translation: 'I am having a party on Saturday. Lots of friends are coming. Please come too.' },
  { id: 'l4-10', level: 4, title: '眠い', text: '昨日の夜、遅くまで勉強しました。今日はとても眠いです。早く寝たいです。', translation: 'Last night I studied until late. Today I am very sleepy. I want to go to bed early.' },

  // Level 5
  { id: 'l5-01', level: 5, title: '私の部屋', text: '私の部屋は二階にあります。あまり広くないですが、明るくて、きれいです。机の上にパソコンと本があります。', translation: 'My room is on the second floor. It is not very big, but it is bright and clean. There is a computer and some books on the desk.' },
  { id: 'l5-02', level: 5, title: '誕生日', text: '昨日は母の誕生日でした。私は花を買って、母にあげました。母はとても喜びました。', translation: 'Yesterday was my mother’s birthday. I bought flowers and gave them to her. She was very happy.' },
  { id: 'l5-03', level: 5, title: '病院', text: '今朝、頭が痛かったです。それで、病院へ行きました。薬をもらって、家で休みました。', translation: 'This morning I had a headache. So I went to the hospital. I got some medicine and rested at home.' },
  { id: 'l5-04', level: 5, title: '夏休み', text: '夏休みに家族と海へ行きました。毎日泳いで、魚を食べました。とても楽しい旅行でした。', translation: 'During the summer holidays I went to the sea with my family. We swam every day and ate fish. It was a very fun trip.' },
  { id: 'l5-05', level: 5, title: 'アルバイト', text: '私は週に三回、喫茶店でアルバイトをしています。仕事は大変ですが、店の人はみんな親切です。', translation: 'I work part-time at a café three times a week. The work is hard, but everyone at the shop is kind.' },
  { id: 'l5-06', level: 5, title: '電車の中', text: '朝の電車はいつも人が多いです。私は電車の中で本を読んだり、音楽を聞いたりします。', translation: 'The morning train is always crowded. On the train I read books, listen to music and so on.' },
  { id: 'l5-07', level: 5, title: '冬', text: '私の町の冬は長くて、寒いです。雪がたくさん降ります。でも、私は冬が好きです。', translation: 'Winter in my town is long and cold. It snows a lot. But I like winter.' },
  { id: 'l5-08', level: 5, title: '日本語の授業', text: '日本語の授業は月曜日と木曜日です。先生は優しくて、授業はいつも面白いです。', translation: 'Japanese class is on Mondays and Thursdays. The teacher is kind, and class is always interesting.' },
  { id: 'l5-09', level: 5, title: '道を聞く', text: 'すみません、郵便局はどこですか。この道をまっすぐ行くと、銀行の隣にありますよ。', translation: 'Excuse me, where is the post office? If you go straight along this road, it’s next to the bank.' },
  { id: 'l5-10', level: 5, title: '料理', text: '私は料理が上手じゃありません。でも、カレーは作ることができます。今晩、友達に作ります。', translation: 'I am not good at cooking. But I can make curry. Tonight I will make it for a friend.' },

  // Level 6
  { id: 'l6-01', level: 6, title: '引っ越し', text: '来月、新しいアパートに引っ越すことにしました。今のアパートより駅に近いので、通勤が楽になると思います。', translation: 'I have decided to move to a new apartment next month. It is closer to the station than my current one, so I think commuting will be easier.' },
  { id: 'l6-02', level: 6, title: '忘れ物', text: '電車に傘を忘れてしまいました。駅の人に聞いたら、もう届いていると言われました。とても助かりました。', translation: 'I left my umbrella on the train. When I asked at the station, they told me it had already been handed in. That was a big help.' },
  { id: 'l6-03', level: 6, title: '健康', text: '最近、あまり運動していないので、毎朝三十分歩くようにしています。体の調子がよくなってきました。', translation: 'I haven’t been exercising much lately, so I make a point of walking for thirty minutes every morning. My body has started to feel better.' },
  { id: 'l6-04', level: 6, title: '試験', text: '来週、日本語の試験があります。漢字を覚えなければなりませんが、なかなか覚えられません。', translation: 'Next week I have a Japanese exam. I have to memorise kanji, but I just can’t remember them.' },
  { id: 'l6-05', level: 6, title: '旅行の計画', text: '春休みに北海道へ旅行するつもりです。おいしいものを食べたり、温泉に入ったりしたいです。', translation: 'I plan to travel to Hokkaido during the spring break. I want to eat good food and go to hot springs.' },
  { id: 'l6-06', level: 6, title: '雨の予報', text: '天気予報によると、明日は午後から雨が降るそうです。出かけるときは、傘を持っていったほうがいいです。', translation: 'According to the weather forecast, it will rain from the afternoon tomorrow. You had better take an umbrella when you go out.' },
  { id: 'l6-07', level: 6, title: '新しい趣味', text: '去年からピアノを習っています。最初は難しかったですが、今は簡単な曲が弾けるようになりました。', translation: 'I have been learning the piano since last year. It was difficult at first, but now I can play simple pieces.' },
  { id: 'l6-08', level: 6, title: '友達の家', text: '週末に友達の家に招待されました。お土産にケーキを持っていったら、とても喜んでくれました。', translation: 'I was invited to a friend’s house at the weekend. When I brought a cake as a gift, they were very pleased.' },
  { id: 'l6-09', level: 6, title: '遅刻', text: '今朝は寝坊して、会社に遅れてしまいました。これからは目覚まし時計を二つかけようと思います。', translation: 'This morning I overslept and was late for work. From now on I think I will set two alarm clocks.' },
  { id: 'l6-10', level: 6, title: '図書館のルール', text: 'この図書館では、本を二週間借りることができます。でも、辞書は借りられないので、ここで使ってください。', translation: 'At this library you can borrow books for two weeks. But dictionaries can’t be borrowed, so please use them here.' },
];
