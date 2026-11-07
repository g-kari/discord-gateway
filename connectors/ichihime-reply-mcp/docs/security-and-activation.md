# セキュリティレビューと有効化前チェック

## 必要な構成と個別承認

配備前に次の実対象を確定し、必要な承認を得ます。このチェックリストは承認の代わりにはなりません。

1. 新規Worker `ichihime-discord-reply-mcp` の配備先アカウントとHTTPS URL。既存 `discord-gateway` は変更しない。
2. 本人だけを認証し、MCP用resource/audienceとscopeを発行する認可サーバー。既存の承認済みサーバーが再利用できる場合も、resource/scopeや継続アクセスを追加するなら明示承認を得る。新OAuth grant・credential・Service Binding・server-side secretの作成/追加を勝手に行わない。
3. private `AUTH_SERVER` RPC binding。`validateToken(resource, token)` は公式provider 1.2.4の形式 `{ audience, expiresAt, userId, scope, clientId, props }` を返し、userIdは認証された実本人subjectにする。ユーザー入力や表示名からsubjectを作らない。
4. private `GATEWAY_SERVICE` bindingの対象は既存 `discord-gateway` に限定する。コネクタは `/send` 以外を使わない。
5. `GATEWAY_ADMIN_KEY` は既存Gateway管理キーと対応するserver-side secret。新Workerへ置くことは継続アクセスの追加になるため、対象と影響を本人に説明し、個別承認後に安全なUI/手順で設定する。値を取り出して会話、ソース、ZIP、CLI引数、ログに残さない。
6. `OWNER_SUBJECT`、`MCP_SERVER_URL`、`AUTH_SERVER_URL` を検証済みの実値で設定する。
7. `ALLOWED_TARGETS_JSON` は本人が承認したguild/channelに絞る。正規Discordメタデータでguild、channel ID、type 0/5を確認し、Botのアクセス範囲が既存権限内か照合する。確認できなければ空のまま止める。既存の進捗投稿先への承認を返信全般へ広げない。
8. 最初は `SEND_ENABLED=false`、公開previewなし、自動ログなし。実動作検証後、許可された場合だけ送信を有効化する。

## 残るリスクと制約

- 既存管理キーはGatewayの `/connect` `/avatar` `/send` に権限を持つ。コネクタのコードは `/send` に固定していても、Worker自体が侵害された場合のキーの権限は縮まらない。将来的なGateway側の一姫送信専用credential/入口の追加は別レビュー対象。この成果物はGatewayを変更しない。
- 既存 `/send` は要求IDによる送信重複排除がない。外側で予約して結果不明時に再送を止めるため二重送信を避けるが、その代わり送信前クラッシュ時にも欠送になることがある。これはat-most-once試行であり、exactly-once配送の保証ではない。
- Gateway自身が429を内部再試行する既存動作は変えない。コネクタはさらに自動再送を重ねない。
- 許可リストは実メタデータ確認後の静的attestationであり、毎回Discordメタデータを読むものではない。未確認の値で送信有効化しない。送信権限と本人の毎回の送信許可は別物。
- 元message IDと本文に対する本人許可の成立は、呼び出し元と運用が確認する。イベントのテキストだけを本人の命令と解釈しない。
- 本文に機微情報がないことをコードで完全検出することはできない。ツール説明と利用手順で通常の低影響通信に限定し、秘密情報や高影響通信を送らない。
- 検証済みreceiptが得られなければ、実際に送信済みでもunknownとなる。ledgerを削除/初期化して再送しない。message ID/日時/対象を正規の許可された方法で照合する。
- ledgerは自動消去しない。保持期間や削除を変えると古いsource IDの再送防止に影響するため、別途設計・承認が必要。

## 本人へまとめて確認できる最小の次手

「指定するCloudflareアカウントに新返信Workerを配備し、本人認証用の限定scopeとprivate service binding、Gateway管理キーをserver-side secretとして追加して、本人が指定するguild/channelだけを許可してよいですか。これは既存Gatewayへの継続アクセスを新Workerに追加します。Botトークンは移しません。最初は送信無効で検証します。」

実アカウント、認可サーバー、scope、送り先が未確定なら先に確定し、それらを含む具体的な確認に直してください。実送信は、この構成承認とは分けて対象と本文を示して確認します。課金や契約が増える場合は、その内容を別途示してください。
