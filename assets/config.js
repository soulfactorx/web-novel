// 사이트 설정. 수정 후 main 에 push 하면 반영된다.
export default {
  // 본문 보호 (리더 화면에만 적용)
  // 웹페이지에서는 복사·캡처를 완전히 막을 수 없고, 일반적인 방법을 어렵게 만드는 정도다.
  protect: {
    copy: true,        // 텍스트 선택·복사·우클릭·드래그·인쇄·저장(Ctrl+S) 막기
    blurOnLeave: true, // 창이 포커스를 잃거나 다른 탭으로 가면 본문 가리기 (캡처 도구 대응)
    printScreen: true, // PrintScreen 키를 누르면 본문을 가리고 클립보드 비우기
    watermark: '',     // 본문 위에 옅게 반복 표시할 문구 (예: '개인 열람용'). 빈 문자열이면 표시 안 함
  },
};
