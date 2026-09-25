import { Button } from "@fluentui/react-components";
import { StarFilled, StarRegular } from "@fluentui/react-icons";
import { favoriteId, toggleFavorite, useObjectPreferences, type FavoriteObject } from "../../stores/useObjectPreferences";
import { useNotify } from "../../app/toast";

export function FavoriteButton({ item }: { item: FavoriteObject }) {
  const saved = useObjectPreferences(state => state.favorites.some(value => favoriteId(value) === favoriteId(item)));
  const notify = useNotify();
  return <Button className={saved ? "dw-favorite-saved" : "dw-favorite-idle"} size="small" appearance="subtle" icon={saved ? <StarFilled /> : <StarRegular />} title={saved ? "取消收藏" : "收藏对象"} aria-label={saved ? "取消收藏" : "收藏对象"} onClick={event => { event.stopPropagation(); void toggleFavorite(item).catch(error => notify.error(error, "保存收藏失败")); }} />;
}
